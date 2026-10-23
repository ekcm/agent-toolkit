"""Extract a code graph from a git repository into a repo-wiki workspace.

Usage:
  python extract.py --repo <path> --out <workspace> [--scope <subdir>] [--max-embed-kb 3000] [--workers N]

Writes <workspace>/graph.json and <workspace>/sources.json. Never writes inside the repository.
Parsing is syntactic (tree-sitter): declarations, imports, call sites, decorators and annotations
are exact, but which implementation a call reaches is resolved by name and is therefore a best guess.
"""
import argparse
import fnmatch
import json
import math
import multiprocessing
import os
import posixpath
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

try:
    from tree_sitter_language_pack import get_parser
except ImportError:  # verify.py imports this module for tree_fingerprint without needing tree-sitter
    get_parser = None

SCHEMA = 1

EXT_LANG = {
    ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".py": "python",
    ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".go": "go", ".rs": "rust", ".rb": "ruby",
}
# Languages whose natural unit is the class; everywhere else a file (module) is one unit.
CLASS_UNIT_LANGS = {"java", "kotlin"}

SPEC = {
    "java": dict(types={"class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"},
                 funcs={"method_declaration", "constructor_declaration"},
                 calls={"method_invocation", "object_creation_expression"},
                 imports={"import_declaration"}, decos={"marker_annotation", "annotation"}),
    "kotlin": dict(types={"class_declaration", "object_declaration"}, funcs={"function_declaration"},
                   calls={"call_expression"}, imports={"import_header"}, decos={"annotation"}),
    "python": dict(types={"class_definition"}, funcs={"function_definition"}, calls={"call"},
                   imports={"import_statement", "import_from_statement"}, decos={"decorator"}),
    "typescript": dict(types={"class_declaration", "abstract_class_declaration", "interface_declaration", "enum_declaration"},
                       funcs={"function_declaration", "method_definition", "generator_function_declaration"},
                       calls={"call_expression", "new_expression"}, imports={"import_statement"}, decos={"decorator"}),
    "go": dict(types={"type_spec"}, funcs={"function_declaration", "method_declaration"}, calls={"call_expression"},
               imports={"import_spec"}, decos=set()),
    "rust": dict(types={"struct_item", "enum_item", "trait_item"}, funcs={"function_item"},
                 calls={"call_expression"}, imports={"use_declaration"}, decos={"attribute_item"}),
    "ruby": dict(types={"class", "module"}, funcs={"method", "singleton_method"}, calls={"call"}, imports=set(), decos=set()),
}
SPEC["tsx"] = SPEC["typescript"]
SPEC["javascript"] = SPEC["typescript"]

SKIP_DIRS = {".git", "node_modules", "vendor", "dist", "build", "target", "out", ".venv", "venv", "env", "__pycache__",
             ".next", ".nuxt", "coverage", ".gradle", ".idea", ".vscode", "generated", "gen", "site-packages",
             "third_party", "third-party", ".terraform", "bower_components", "htmlcov", ".mypy_cache", ".pytest_cache", ".tox"}
SKIP_FILE = re.compile(r"(\.min\.js|\.d\.ts|\.pb\.go|_pb2(_grpc)?\.py|\.generated\.\w+|\.gen\.\w+)$")
TEST_PATH = re.compile(r"(^|/)(tests?|__tests__|spec|specs|testing|e2e|it|integration-tests?)(/|$)|(^|/)src/test/|"
                       r"(_test\.(go|py|rb)|\.test\.[jt]sx?|\.spec\.[jt]sx?|(^|/)test_[^/]*\.py|Tests?\.(java|kt)|IT\.(java|kt)|_spec\.rb)$")
DB_CODE = (r"\b(JdbcTemplate|NamedParameterJdbcTemplate|EntityManager|DSLContext|JpaRepository|CrudRepository|PagingAndSortingRepository|"
           r"sessionmaker|AsyncSession|getRepository|knex)\b|\bsession\.(query|execute|add)\b|\.objects\.(filter|get|create|all|exclude)\b|\bprisma\.\w+\.")
# id, label, kind, config evidence, code usage. A node is created only with config/dependency evidence.
INFRA = [
    ("redis", "Redis", "cache", r"\bredis\b", r"\b(RedisTemplate|StringRedisTemplate|ReactiveRedisTemplate|Jedis\w*|RedissonClient|LettuceConnection\w*|ioredis)\b|\bredis\.(Redis|StrictRedis|from_url|createClient)\b|\bnew Redis\("),
    ("rabbitmq", "RabbitMQ", "queue", r"rabbit|\bamqp", r"\b(RabbitTemplate|AmqpTemplate|RabbitListener|StreamBridge|aio_pika|amqplib)\b|\bpika\."),
    ("kafka", "Kafka", "queue", r"\bkafka\b", r"\b(KafkaTemplate|KafkaListener|KafkaConsumer|KafkaProducer|kafkajs|confluent_kafka|AIOKafka\w*)\b"),
    ("sqs", "Amazon SQS", "queue", r"\bsqs\b", r"\b(SqsClient|AmazonSQS\w*|SqsListener|SqsTemplate)\b|boto3\.client\(\s*['\"]sqs"),
    ("postgres", "PostgreSQL", "database", r"postgres|jdbc:postgresql|psycopg|asyncpg", DB_CODE),
    ("mysql", "MySQL", "database", r"\bmysql\b|jdbc:mysql|mariadb", DB_CODE),
    ("mongodb", "MongoDB", "database", r"\bmongo(db)?\b", r"\b(MongoTemplate|MongoRepository|MongoClient|pymongo|mongoose)\b"),
    ("cassandra", "Cassandra", "database", r"\bcassandra\b", r"\b(CqlSession|CassandraTemplate|CassandraRepository)\b|cassandra\.cluster"),
    ("s3", "Amazon S3", "storage", r"\bs3\b|amazon-s3|aws-java-sdk-s3|boto3", r"\b(S3Client|S3AsyncClient|AmazonS3\w*|S3Presigner|S3Template)\b|boto3\.(client|resource)\(\s*['\"]s3"),
    ("elasticsearch", "Elasticsearch", "search", r"elasticsearch|opensearch", r"\b(ElasticsearchClient|RestHighLevelClient|OpenSearchClient|ElasticsearchOperations)\b"),
    ("auth", "Identity provider (JWT)", "auth", r"jwk-set-uri|oauth2|\bjwt\b|keycloak|auth0|cognito", r"\b(JwtDecoder|oauth2ResourceServer|jwt\.decode|jsonwebtoken|JwtAuthenticationToken|AuthenticationFilter)\b"),
]
INFRA_CONFIG = re.compile(r"(^|/)(pom\.xml|build\.gradle(\.kts)?|package\.json|requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|go\.mod|Gemfile|Cargo\.toml|"
                          r"docker-compose[\w.-]*\.ya?ml|application[\w.-]*\.(ya?ml|properties)|settings\.py|config/[\w.-]+\.(ya?ml|json|toml)|\.env\.example)$")
INFRA_WRITE = {  # calls that change state in a store, per kind; anything else touching it counts as a read
    "cache": re.compile(r"\.(set|setIfAbsent|setex|hset|hmset|put|putAll|delete|unlink|expire|evict|lpush|rpush|sadd|zadd|incr\w*)\s*\("),
    "storage": re.compile(r"\b(putObject|PutObjectRequest|upload\w*|deleteObject|copyObject|put_object|upload_file)\b"),
    "search": re.compile(r"\b(index|bulk|update|delete)\w*\s*\("),
}
PUBLISH_WORDS = re.compile(r"\b(send|publish|convertAndSend|produce|emit|put_message|send_message|Supplier)\b", re.I)
FUNCTION_BEAN = re.compile(r"@Bean\s+(?:public\s+)?(Consumer|Function|Supplier)<[^\n]*?>\s+(\w+)\s*\(")
# A tuple, so a folder with several manifests always reports the same one first.
MANIFESTS = ("package.json", "pyproject.toml", "setup.py", "pom.xml", "build.gradle", "build.gradle.kts", "go.mod", "Cargo.toml", "Gemfile", "composer.json")
MAX_PARSE_BYTES = 400_000

# ---------------------------------------------------------------- heuristics
ROUTE_DECO = [
    # Spring / JAX-RS style annotations
    (re.compile(r"@(Get|Post|Put|Patch|Delete)Mapping\b(?:\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*\"([^\"]*)\")?"), "spring"),
    (re.compile(r"@RequestMapping\b(?:\s*\((?:[^)]*?(?:value|path)\s*=\s*)?\{?\s*\"([^\"]*)\")?[^)]*?(?:method\s*=\s*\{?\s*RequestMethod\.(\w+))?"), "spring-req"),
    # FastAPI / Flask / Starlette style decorators: @app.get("/x"), @router.post("/x"), @bp.route("/x")
    (re.compile(r"@\s*[\w.]+\.(get|post|put|patch|delete|route|api_route|websocket|head|options)\(\s*[\"']([^\"']*)"), "pydeco"),
    # NestJS style: @Get('x')
    (re.compile(r"@(Get|Post|Put|Patch|Delete|All|Head|Options)\(\s*(?:[\"'`]([^\"'`]*))?"), "nest"),
]
ROUTE_CALL = re.compile(
    r"^\s*(?:\w+\.)*(app|router|server|api|r|e|g|mux|route|routes|v\d|group|engine|fastify|hono)\.(get|post|put|patch|delete|all|head|options|"
    r"GET|POST|PUT|PATCH|DELETE|Handle|HandleFunc|Get|Post|Put|Patch|Delete|Any)\s*\(\s*[\"'`]([^\"'`]+)")
GO_HANDLEFUNC = re.compile(r"^\s*http\.(HandleFunc|Handle)\s*\(\s*\"([^\"]+)")
DJANGO_PATH = re.compile(r"^\s*(re_)?path\s*\(\s*r?[\"']([^\"']*)[\"']\s*,\s*([\w.]+)")
CLASS_PREFIX = [re.compile(r"@RequestMapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*\"([^\"]*)\""),
                re.compile(r"@Controller\(\s*[\"'`]([^\"'`]*)"), re.compile(r"@Path\(\s*\"([^\"]*)\"")]
PY_ROUTER_PREFIX = re.compile(r"APIRouter\([^)]*prefix\s*=\s*[\"']([^\"']*)")
TRIGGER_DECO = [
    (re.compile(r"@Scheduled\s*\(([^)]*)\)"), "schedule"),
    (re.compile(r"@(?:\w+\.)?(shared_task|periodic_task|task)\b(\([^)]*\))?"), "task"),
    (re.compile(r"@Cron\s*\(([^)]*)\)"), "schedule"),
    (re.compile(r"@(KafkaListener|RabbitListener|SqsListener|JmsListener|StreamListener|EventPattern|MessagePattern)\b(\([^)]*\))?"), "consumer"),
]
APP_CTOR = re.compile(r"^\s*(?:export\s+)?(?:const\s+|let\s+|var\s+)?(\w+)\s*:?=\s*(?:new\s+)?(FastAPI|Flask|Celery|Starlette|express|Hono|Fastify|fastify|Koa|NestFactory\.create|gin\.(?:Default|New)|echo\.New|chi\.NewRouter|mux\.NewRouter|http\.NewServeMux)\s*[(<]", re.M)
TRIGGER_CALL = [
    (re.compile(r"\bcron\.schedule\s*\(\s*[\"']([^\"']+)"), "schedule"),
    (re.compile(r"\bschedule\.every\b[^\n]*"), "schedule"),
    (re.compile(r"\.add_job\s*\("), "schedule"),
    (re.compile(r"\bnew\s+Worker\s*(?:<[^>]*>)?\s*\(\s*([\w.]+|[\"'][^\"']+)"), "consumer"),
]
NEXT_API = re.compile(r"(?:^|/)pages/api/(.+?)\.(?:t|j)sx?$")
NEXT_ROUTE = re.compile(r"(?:^|/)app/(.*?)/?route\.(?:t|j)s$")
OUTBOUND = re.compile(
    r"\b(RestTemplate|WebClient|@FeignClient|HttpClient\.new|OkHttpClient|requests\.(get|post|put|patch|delete|request|Session)\b|"
    r"httpx\.|aiohttp\.ClientSession|urllib\.request|axios\b|(?<![.\w])fetch\s*\(|(?<![.\w])got\s*\(|(?<![.\w])ky\.|http\.(Get|Post|NewRequest)\b|"
    r"reqwest::|Net::HTTP|Faraday\.|grpc\.(insecure_channel|secure_channel)|NewClient\()")
SQL_CREATE = re.compile(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\"`\[]?(?:\w+[\"`\]]?\.[\"`\[]?)?(\w+)", re.I)
SQL_ALTER = re.compile(r"ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?[\"`]?(?:\w+\.)?(\w+)[\"`]?\s+(RENAME\s+TO\s+[\"`]?(\w+))?", re.I)
SQL_DROP = re.compile(r"DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[\"`]?(?:\w+\.)?(\w+)", re.I)
ORM_TABLE = [
    re.compile(r"@Table\s*\(\s*name\s*=\s*\"(\w+)\""),
    re.compile(r"__tablename__\s*=\s*[\"'](\w+)"),
    re.compile(r"@Entity\(\s*[\"'](\w+)"),
    re.compile(r"\bmodel\s*\(\s*[\"'](\w+)[\"']\s*,"),
]
WRITE_WORDS = re.compile(r"\b(insert|insertInto|update|upsert|delete|deleteFrom|merge|save|saveAll|create|bulk_create|add|persist|INSERT|UPDATE|DELETE)\b")

LAYERS = [
    # id, label, lane
    ("entry", "Entry point", 0), ("interface", "Handler", 1), ("job", "Job / consumer", 1), ("ui", "UI component", 1), ("service", "Service", 2),
    ("logic", "Logic", 2), ("client", "Outbound client", 3), ("data", "Data access", 3), ("table", "Table", 4),
    ("external", "External system", 4), ("mapper", "Mapper", 4), ("model", "Model", 5), ("config", "Config", 5), ("util", "Utility", 5),
]
LAYER_W = {"entry": 0.9, "interface": 0.9, "ui": 0.45, "job": 1.0, "service": 0.85, "logic": 0.7, "client": 0.85, "data": 0.75,
           "table": 0.8, "external": 1.0, "mapper": 0.45, "model": 0.4, "config": 0.35, "util": 0.3}
UI_PATH = re.compile(r"\.(tsx|jsx|vue|svelte)$")
PATH_LAYER = [
    (re.compile(r"(^|/)(repositor(y|ies)|repos?|dao|daos|persistence|store|stores|db|database|queries|crud)(/|\.|$)|Repository$|Dao$|Store$", re.I), "data"),
    (re.compile(r"(^|/)(controllers?|handlers?|routes?|routers?|views?|endpoints?)(/|\.|$)|Controller$|Handler$|Resource$|Router$", re.I), "interface"),
    (re.compile(r"(^|/)(jobs?|tasks?|workers?|consumers?|listeners?|schedulers?|cron)(/|\.|$)|Job$|Worker$|Consumer$|Listener$", re.I), "job"),
    (re.compile(r"(^|/)(clients?|integrations?|gateways?|adapters?/out|external)(/|\.|$)|Client$|Gateway$", re.I), "client"),
    (re.compile(r"(^|/)(mappers?|converters?|transformers?|serializers?|postprocessing)(/|\.|$)|Mapper$|Converter$|Serializer$|Transformer$", re.I), "mapper"),
    (re.compile(r"(^|/)(config|configs|configuration|settings|bootstrap|setup|di)(/|\.|$)|Config(uration)?$|Settings$|Module$", re.I), "config"),
    (re.compile(r"(^|/)(models?|entities|entity|dto|dtos|schemas?|types|domain/model|enums?|exceptions?|errors?)(/|\.|$)|DTO$|Dto$|Entity$|Exception$|Error$", re.I), "model"),
    (re.compile(r"(^|/)(utils?|helpers?|common|shared|lib|libs|support|tools)(/|\.|$)|Utils?$|Helper$", re.I), "util"),
    (re.compile(r"(^|/)(services?|usecases?|use_cases|domain|core|application|app|managers?)(/|\.|$)|Service$|Manager$|UseCase$", re.I), "service"),
]
ANNO_LAYER = {"RestController": "interface", "Controller": "interface", "RestControllerAdvice": "config", "Service": "service",
              "Repository": "data", "Configuration": "config", "Entity": "model", "Injectable": "service", "Module": "config"}


SECRET_FILE = re.compile(r"(^|/)(\.env(\.[\w.-]+)?|[^/]*(secret|credential|private[_-]?key)[^/]*|[^/]*\.(pem|key|p12|pfx|jks|keystore))$", re.I)
SECRET_LINE = re.compile(r"(?i)((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)[\w.-]*[\"']?\s*[:=]\s*[\"']?)"
                         r"(?!\$\{|<|\s*$|[\"']?\s*$|null\b|None\b|os\.|process\.env|System\.getenv|env\(|getenv|config\.|settings\.)([^\s\"',;]{6,})")
SECRET_QUOTED = re.compile(r"(?i)((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)[\w.-]*[\"']?\s*[:=]\s*[\"'])([^\"'\s$<{]{6,})(?=[\"'])")
SECRET_TOKEN = re.compile(r"(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{20,}|xox[bpa]-[A-Za-z0-9-]{10,})")


def top(counter, n=None):
    """Counter.most_common, but ties broken by key, so equal counts come out in the same order every run."""
    return sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0])))[:n]


def redact(text, code=False):
    """Blank out values that look like secrets; keeps every line in place so refs stay valid.
    In source code only quoted literals are touched, so `token = createToken(user)` survives."""
    n = 0

    def sub_line(m):
        nonlocal n
        n += 1
        return m.group(1) + "<redacted>"
    text = (SECRET_QUOTED if code else SECRET_LINE).sub(sub_line, text)
    text, k = SECRET_TOKEN.subn("<redacted>", text)
    return text, n + k


def tree_fingerprint(root):
    """Identifies HEAD plus any uncommitted changes to tracked files, so verify.py can tell if the code moved after extraction."""
    import hashlib
    h = hashlib.sha1(git(root, "rev-parse", "HEAD").encode())
    h.update(subprocess.run(["git", "-C", root, "diff", "HEAD", "--no-color"], capture_output=True).stdout)
    return h.hexdigest()[:16]


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, errors="replace").stdout


def text_of(node):
    return node.text.decode("utf-8", "replace")


def line(node):
    return node.start_point[0] + 1


def last_ident(s):
    s = re.sub(r"<[^<>]*>", "", s)
    m = re.search(r"([A-Za-z_$][\w$]*)\s*[!?]?\s*$", s)
    return m.group(1) if m else None


def receiver_of(s):
    s = re.sub(r"<[^<>]*>", "", s).strip()
    parts = re.split(r"\.|::|\?\.", s)
    return parts[-2].strip() if len(parts) > 1 else None


def load_config(out):
    path = os.path.join(out, "config.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as fh:
            cfg = json.load(fh)
    except ValueError as e:
        sys.exit(f"{path} is not valid JSON: {e}")
    if not isinstance(cfg, dict):
        sys.exit(f"{path} must be a JSON object with optional 'exclude' and 'layers' keys.")
    if not isinstance(cfg.get("exclude", []), list) or not all(isinstance(g, str) for g in cfg.get("exclude", [])):
        sys.exit(f"{path}: 'exclude' must be a list of glob strings.")
    known = {lid for lid, _, _ in LAYERS}
    for i, r in enumerate(cfg.get("layers", [])):
        if not isinstance(r, dict) or not isinstance(r.get("match"), str) or r.get("layer") not in known:
            sys.exit(f"{path}: layers[{i}] must be {{\"match\": \"<regex>\", \"layer\": one of {sorted(known)}}}, got {r!r}")
        try:
            re.compile(r["match"])
        except re.error as e:
            sys.exit(f"{path}: layers[{i}].match is not a valid regular expression: {e}")
    for i, r in enumerate(cfg.get("groups", [])):
        if not isinstance(r, dict) or not isinstance(r.get("match"), str) or not isinstance(r.get("group"), str) or not r["group"].strip():
            sys.exit(f"{path}: groups[{i}] must be {{\"match\": \"<regex>\", \"group\": \"<name>\"}}, got {r!r}")
        try:
            re.compile(r["match"])
        except re.error as e:
            sys.exit(f"{path}: groups[{i}].match is not a valid regular expression: {e}")
    return cfg


# ---------------------------------------------------------------- parsing
class FileInfo:
    """Everything extracted from one file. Built in worker processes and pickled back to the parent,
    so it must hold only plain data (never a tree-sitter Node)."""

    def __getstate__(self):  # `lines` is just `text` split; rebuild it on arrival instead of sending it twice
        state = dict(self.__dict__)
        state.pop("lines", None)
        return state

    def __setstate__(self, state):
        self.__dict__.update(state)
        self.lines = self.text.split("\n")

    def __init__(self, path, lang, text):
        self.path, self.lang, self.text = path, lang, text
        self.lines = text.split("\n")
        self.types = []        # {name, kind, line, end, decos, extends, implements, methods:[...]}
        self.funcs = []        # top-level functions {name, line, end, decos}
        self.imports = []      # {module, names:[(name, alias)], line, alias}
        self.calls = []        # {name, recv, line, fn}
        self.typerefs = Counter()
        self.decos = []        # (text, line, owner_fn, owner_type)
        self.fields = {}       # field/param name -> type name


def parse_file(path, lang, text):
    info = FileInfo(path, lang, text)
    spec = SPEC[lang]
    tree = get_parser(lang).parse(text.encode("utf-8"))
    # explicit stack: (node, enclosing type dict, enclosing function name, depth-of-type)
    stack = [(tree.root_node, None, None)]
    while stack:
        node, cur_type, cur_fn = stack.pop()
        t = node.type
        nt, nf = cur_type, cur_fn
        if t in spec["types"]:
            name_node = node.child_by_field_name("name")
            name = text_of(name_node) if name_node else None
            if name:
                td = {"name": name, "kind": t.replace("_declaration", "").replace("_definition", "").replace("_item", "").replace("_spec", ""),
                      "line": line(node), "end": node.end_point[0] + 1, "decos": [], "extends": [], "implements": [], "methods": [],
                      "nested": cur_type is not None}
                header = text[node.start_byte: (node.child_by_field_name("body") or node).start_byte] if node.child_by_field_name("body") else text_of(node).split("{")[0]
                td["decos"] = re.findall(r"@[\w.]+(?:\([^)]*\))?", header)
                m = re.search(r"\bextends\s+([\w.<>, ]+?)(?:\bimplements\b|\{|$)", header, re.S)
                if m:
                    td["extends"] = [last_ident(x) for x in m.group(1).split(",") if last_ident(x)]
                m = re.search(r"\bimplements\s+([\w.<>, ?]+?)(?:\{|$)", header, re.S)
                if m:
                    td["implements"] = [last_ident(x) for x in m.group(1).split(",") if last_ident(x)]
                if lang == "python":
                    sup = node.child_by_field_name("superclasses")
                    if sup:
                        td["extends"] = [last_ident(text_of(c)) for c in sup.named_children if last_ident(text_of(c))]
                if lang == "kotlin":
                    m = re.search(r"\)\s*:\s*([\w.<>, ()]+?)\s*(\{|$)", header) or re.search(r"\b" + re.escape(name) + r"\s*:\s*([\w.<>, ()]+?)\s*(\{|$)", header)
                    if m:
                        td["extends"] = [last_ident(x.split("(")[0]) for x in m.group(1).split(",") if last_ident(x.split("(")[0])]
                info.types.append(td)
                nt = td
        elif t in spec["funcs"] or (t == "variable_declarator" and lang in ("typescript", "tsx", "javascript")
                                    and node.child_by_field_name("value") is not None
                                    and node.child_by_field_name("value").type in ("arrow_function", "function_expression", "function")):
            name_node = node.child_by_field_name("name")
            name = text_of(name_node) if name_node else None
            if name:
                fd = {"name": name, "line": line(node), "end": node.end_point[0] + 1}
                prev = node.prev_named_sibling
                decos = []
                while prev is not None and prev.type in spec["decos"]:
                    decos.insert(0, (text_of(prev), line(prev)))
                    prev = prev.prev_named_sibling
                if node.parent is not None and node.parent.type == "decorated_definition":
                    decos = [(text_of(d), line(d)) for d in node.parent.named_children if d.type == "decorator"]
                mods = node.child_by_field_name("modifiers") or next((c for c in node.children if c.type == "modifiers"), None)
                if mods is not None:
                    decos += [(text_of(a), line(a)) for a in mods.named_children if a.type in spec["decos"]]
                fd["decos"] = [d for d, _ in decos]
                for d, dl in decos:
                    info.decos.append((d, dl, name, cur_type["name"] if cur_type else None))
                if cur_type is not None:
                    cur_type["methods"].append(fd)
                else:
                    info.funcs.append(fd)
                nf = name
        elif t in spec["calls"]:
            fn_node = (node.child_by_field_name("function") or node.child_by_field_name("constructor")
                       or node.child_by_field_name("type") or node.child_by_field_name("method"))
            if t == "method_invocation":
                nm = node.child_by_field_name("name")
                obj = node.child_by_field_name("object")
                name, recv = (text_of(nm) if nm else None), (last_ident(text_of(obj)) if obj else None)
            elif fn_node is not None:
                s = text_of(fn_node)
                name, recv = last_ident(s), receiver_of(s)
                if recv:
                    recv = last_ident(recv)
            elif lang == "ruby":
                m = node.child_by_field_name("method")
                r = node.child_by_field_name("receiver")
                name, recv = (text_of(m) if m else None), (last_ident(text_of(r)) if r else None)
            else:
                first = node.named_children[0] if node.named_children else None
                s = text_of(first) if first else ""
                name, recv = last_ident(s), receiver_of(s)
            if name and len(name) > 1:
                info.calls.append({"name": name, "recv": recv, "line": line(node), "fn": cur_fn,
                                   "type": cur_type["name"] if cur_type else None, "new": t in ("object_creation_expression", "new_expression")})
        elif t in spec["imports"]:
            info.imports.append(read_import(node, lang))
        elif t in ("type_identifier",) and lang in ("java", "kotlin", "typescript", "tsx", "go", "rust"):
            info.typerefs[text_of(node)] += 1
        elif t in spec["decos"] and cur_fn is None and not (node.parent and node.parent.type in ("decorated_definition",)):
            info.decos.append((text_of(node), line(node), None, cur_type["name"] if cur_type else None))
        for c in reversed(node.children):
            stack.append((c, nt, nf))
    # field / constructor-parameter types, used to resolve receivers like this.importService.save()
    for m in re.finditer(r"(?:private|protected|public|readonly|final|val|var|\s)\s+(?:final\s+)?([A-Z][\w]*)(?:<[^>]*>)?\s+([a-z]\w*)\s*[;=,)]", text):
        info.fields.setdefault(m.group(2), m.group(1))
    for m in re.finditer(r"\b([a-z_]\w*)\s*:\s*(?:List<|Array<|Set<)?([A-Z]\w*)", text):
        info.fields.setdefault(m.group(1), m.group(2))
    for m in re.finditer(r"self\.(\w+)\s*(?::\s*([A-Z]\w*))?\s*=\s*([A-Z]\w*)?", text):
        if m.group(2) or m.group(3):
            info.fields.setdefault(m.group(1), m.group(2) or m.group(3))
    return info


PARALLEL_MIN_FILES = 300  # below this, starting worker processes costs more than it saves
FILES_PER_WORKER = 50     # never start more workers than this many files per worker can keep busy


def default_workers():
    """CPUs this process may actually use (a container's quota on Linux), capped at 8: past that the
    gain is small and each worker costs ~50 MB. Windows refuses more than 61 workers anyway."""
    n = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else (os.cpu_count() or 1)
    return max(1, min(8, n))


def _ignore_sigint():
    # Workers ignore Ctrl-C; the parent handles it and stops them (see parse_all).
    import signal
    signal.signal(signal.SIGINT, signal.SIG_IGN)


def load_and_parse(job):
    """Read and parse one file (runs in a worker process). Returns (path, lang, FileInfo or None, warning or None)."""
    root, p = job
    full = os.path.join(root, p)
    try:
        if os.path.getsize(full) > MAX_PARSE_BYTES:
            return p, None, None, None
        with open(full, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return p, None, None, None
    lang = EXT_LANG[os.path.splitext(p)[1]]
    try:
        return p, lang, parse_file(p, lang, text), None
    except Exception as e:  # a grammar failure on one file must not stop the run
        return p, lang, None, f"warn: could not parse {p}: {e}"


def parse_all(root, paths, workers):
    """Parse files across `workers` processes. Results come back in input order, so the graph is the same as a serial run."""
    jobs = [(root, p) for p in paths]
    workers = min(workers, 61, len(jobs) // FILES_PER_WORKER or 1)
    if workers <= 1 or len(jobs) < PARALLEL_MIN_FILES:
        return [load_and_parse(j) for j in jobs]
    from concurrent.futures import ProcessPoolExecutor
    from concurrent.futures.process import BrokenProcessPool
    chunk = max(1, len(jobs) // (workers * 8))
    pool = ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn"), initializer=_ignore_sigint)
    try:
        results = list(pool.map(load_and_parse, jobs, chunksize=chunk))
    except KeyboardInterrupt:
        # A normal shutdown can deadlock here: workers block writing large results into a pipe nobody
        # reads any more. Kill them and leave at once. (_processes is private but has no public equivalent.)
        for proc in list((pool._processes or {}).values()):
            proc.kill()
        print("interrupted", file=sys.stderr)
        os._exit(130)
    except BrokenProcessPool:
        for proc in list((pool._processes or {}).values()):
            proc.kill()
        sys.exit("A parser process crashed (most likely a grammar failing on one file). "
                 "Re-run with --workers 1 to see which file, then add it to `exclude` in the workspace config.json.")
    pool.shutdown()
    return results


def read_import(node, lang):
    s = text_of(node)
    imp = {"line": line(node), "module": None, "names": [], "alias": None, "raw": s.strip()[:200]}
    if lang in ("java", "kotlin"):
        m = re.search(r"import\s+(static\s+)?([\w.]+)(\.\*)?(?:\s+as\s+(\w+))?", s)
        if m:
            imp["module"] = m.group(2)
            imp["names"] = [(m.group(2).split(".")[-1], m.group(4))]
            imp["wildcard"] = bool(m.group(3))
    elif lang == "python":
        m = re.match(r"from\s+(\.*[\w.]*)\s+import\s+(.+)", s, re.S)
        if m:
            imp["module"] = m.group(1)
            body = m.group(2).replace("(", "").replace(")", "").replace("\\", "")
            for part in body.split(","):
                p = part.strip().split()
                if p and p[0] != "*":
                    imp["names"].append((p[0], p[2] if len(p) >= 3 and p[1] == "as" else None))
        else:
            for part in s[len("import"):].split(","):
                p = part.strip().split()
                if p:
                    imp.setdefault("modules", []).append((p[0], p[2] if len(p) >= 3 and p[1] == "as" else None))
            if imp.get("modules"):
                imp["module"], imp["alias"] = imp["modules"][0]
    elif lang in ("typescript", "tsx", "javascript"):
        m = re.search(r"from\s+[\"']([^\"']+)[\"']", s) or re.search(r"import\s+[\"']([^\"']+)[\"']", s)
        if m:
            imp["module"] = m.group(1)
        m2 = re.search(r"\{([^}]*)\}", s)
        if m2:
            for part in m2.group(1).split(","):
                p = part.strip().replace("type ", "").split()
                if p:
                    imp["names"].append((p[0], p[2] if len(p) >= 3 and p[1] == "as" else None))
        m3 = re.search(r"\*\s+as\s+(\w+)", s)
        if m3:
            imp["alias"] = m3.group(1)
        m4 = re.match(r"import\s+(\w+)\s*(,|from)", s)
        if m4:
            imp["names"].append(("default", m4.group(1)))
    elif lang == "go":
        m = re.search(r"(?:(\w+)\s+)?\"([^\"]+)\"", s)
        if m:
            imp["module"], imp["alias"] = m.group(2), m.group(1)
    elif lang == "rust":
        m = re.search(r"use\s+([\w:]+)", s)
        if m:
            imp["module"] = m.group(1)
    return imp


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--scope", default="")
    ap.add_argument("--max-embed-kb", type=int, default=3000)
    ap.add_argument("--workers", type=int, default=default_workers(),
                    help="processes used for parsing (default: usable CPU cores, at most 8; 1 parses serially)")
    args = ap.parse_args()
    if get_parser is None:
        sys.exit("tree-sitter is not installed. Run scripts/setup.sh first and use the Python it prints.")

    repo = os.path.realpath(args.repo)
    root = git(repo, "rev-parse", "--show-toplevel").strip()
    if not root:
        sys.exit(f"{repo} is not inside a git repository.")
    out = os.path.realpath(args.out)
    if out == root or out.startswith(root + os.sep):
        sys.exit("The workspace must be outside the repository.")
    os.makedirs(out, exist_ok=True)
    cfg = load_config(out)
    scope = args.scope.replace("\\", "/").strip("/")
    if scope.startswith("..") or os.path.isabs(args.scope):
        sys.exit("--scope must be a folder inside the repository, relative to its root.")
    excludes = cfg.get("exclude", [])

    tracked = git(root, "ls-files").splitlines()

    def skipped(p):
        parts = p.split("/")
        return (any(x in SKIP_DIRS for x in parts[:-1]) or SKIP_FILE.search(p)
                or any(fnmatch.fnmatch(p, g) for g in excludes))

    files = [p for p in tracked if not skipped(p)]
    in_scope = (lambda p: p == scope or p.startswith(scope + "/")) if scope else (lambda p: True)

    if scope and not any(in_scope(p) for p in tracked):
        sys.exit(f"No tracked files under '{scope}'. Give --scope as a folder relative to {root}.")

    # ---- components (monorepo packages) from manifest files
    manifest_dirs = sorted({os.path.dirname(p) for p in files if os.path.basename(p) in MANIFESTS}, key=lambda d: (-len(d), d))

    def component_of(p):
        for d in manifest_dirs:
            if d == "" or p.startswith(d + "/"):
                return d or "."
        return "."

    # ---- parse code files
    code_files = [p for p in files if os.path.splitext(p)[1] in EXT_LANG]
    test_files = [p for p in code_files if TEST_PATH.search(p)]
    test_set = set(test_files)
    main_files = [p for p in code_files if p not in test_set and in_scope(p)]
    parsed = {}
    lang_count = Counter()
    for p, lang, info, warning in parse_all(root, main_files, args.workers):
        if warning:
            print(warning, file=sys.stderr)
        if info is not None:
            parsed[p] = info
            lang_count[lang] += 1

    if not parsed:
        exts = Counter(os.path.splitext(p)[1] or os.path.basename(p) for p in files if in_scope(p)).most_common(6)
        sys.exit("No supported source files found" + (f" under '{scope}'" if scope else "") +
                 f". Supported: {', '.join(sorted(set(EXT_LANG.values())))}. Most common file types here: {exts}")

    # ---- build units
    nodes, unit_of_file = {}, defaultdict(list)
    sym_units = defaultdict(set)      # symbol name -> unit ids
    used_ids = Counter()

    def new_id(base):
        used_ids[base] += 1
        return base if used_ids[base] == 1 else f"{base}~{used_ids[base]}"

    for p, info in parsed.items():
        comp = component_of(p)
        if info.lang in CLASS_UNIT_LANGS and any(not t["nested"] for t in info.types):
            for td in [t for t in info.types if not t["nested"]]:
                nid = new_id(td["name"])
                nodes[nid] = {"id": nid, "label": td["name"], "type": "unit", "unitKind": td["kind"], "lang": info.lang,
                              "path": p, "line": td["line"], "end": td["end"], "component": comp,
                              "decorators": td["decos"][:8], "extends": td["extends"], "implements": td["implements"],
                              "symbols": [{"name": m["name"], "kind": "method", "line": m["line"], "end": m["end"], "decorators": m["decos"][:4]} for m in td["methods"]]
                              + [{"name": t["name"], "kind": t["kind"], "line": t["line"]} for t in info.types if t["nested"] and td["line"] <= t["line"] <= td["end"]]}
                unit_of_file[p].append(nid)
                sym_units[td["name"]].add(nid)
        else:
            stem = os.path.splitext(os.path.basename(p))[0]
            label = os.path.basename(os.path.dirname(p)) if stem in ("__init__", "index", "mod", "main", "lib") and os.path.dirname(p) else stem
            nid = new_id(os.path.splitext(p)[0])
            syms = [{"name": f["name"], "kind": "function", "line": f["line"], "end": f["end"], "decorators": f["decos"][:4]} for f in info.funcs]
            for td in info.types:
                syms.append({"name": td["name"], "kind": td["kind"], "line": td["line"], "end": td["end"], "decorators": td["decos"][:4]})
                for m in td["methods"]:
                    syms.append({"name": f"{td['name']}.{m['name']}", "kind": "method", "line": m["line"], "end": m["end"], "decorators": m["decos"][:4]})
            first_line = min([s["line"] for s in syms], default=1)
            nodes[nid] = {"id": nid, "label": label, "type": "unit", "unitKind": "module", "lang": info.lang, "path": p,
                          "line": first_line, "end": len(info.lines), "component": comp, "decorators": [],
                          "extends": sorted({e for t in info.types for e in t["extends"]}), "implements": sorted({e for t in info.types for e in t["implements"]}),
                          "symbols": syms}
            unit_of_file[p].append(nid)
            for td in info.types:
                sym_units[td["name"]].add(nid)
            for f in info.funcs:
                sym_units[f["name"]].add(nid)
    # disambiguate duplicate labels
    lab = Counter(n["label"] for n in nodes.values())
    for n in nodes.values():
        if lab[n["label"]] > 1:
            n["label"] = f"{os.path.basename(os.path.dirname(n['path']))}/{n['label']}"

    def unit_at(p, ln):
        for nid in unit_of_file.get(p, []):
            n = nodes[nid]
            if n["line"] <= ln <= n["end"] or len(unit_of_file[p]) == 1:
                return nid
        return unit_of_file[p][0] if unit_of_file.get(p) else None

    # ---- module resolution for file-based languages
    by_noext = {os.path.splitext(p)[0]: p for p in parsed}
    by_suffix = defaultdict(list)  # "a/b/c" -> module paths (no extension) ending in /a/b/c, in by_noext order
    for k in by_noext:
        parts = k.split("/")
        for i in range(1, len(parts)):
            by_suffix["/".join(parts[i:])].append(k)
    noext_order = {k: i for i, k in enumerate(by_noext)}
    by_dir = defaultdict(list)  # folder -> files in it, in parsed order
    for f in parsed:
        by_dir[posixpath.dirname(f)].append(f)
    go_mod = {}
    for d in manifest_dirs:
        gm = os.path.join(root, d, "go.mod")
        if os.path.exists(gm):
            m = re.search(r"^module\s+(\S+)", open(gm).read(), re.M)
            if m:
                go_mod[m.group(1)] = d
    py_roots = sorted({os.path.dirname(p) for p in files if os.path.basename(p) in ("pyproject.toml", "setup.py")} | {""} |
                      {d for d in {os.path.dirname(p) for p in parsed} if d.endswith("/src") or d == "src"}, key=len, reverse=True)

    def resolve_module(p, lang, module):
        if not module:
            return []
        if lang == "python":
            if module.startswith("."):
                dots = len(module) - len(module.lstrip("."))
                base = posixpath.dirname(p)
                for _ in range(dots - 1):
                    base = posixpath.dirname(base)
                rel = module.lstrip(".").replace(".", "/")
                cands = [posixpath.join(base, rel) if rel else base]
            else:
                rel = module.replace(".", "/")
                cands = [posixpath.join(r, rel) if r else rel for r in py_roots]
                cands += by_suffix.get(rel, [])[:3]
            for c in cands:
                c = posixpath.normpath(c)
                if c in by_noext:
                    return unit_of_file[by_noext[c]]
                if c + "/__init__" in by_noext:
                    return unit_of_file[by_noext[c + "/__init__"]]
            return []
        if lang in ("typescript", "tsx", "javascript"):
            if not module.startswith("."):
                m = re.match(r"^(?:@/|~/)(.*)", module)
                if not m:
                    return []
                cands = sorted(set(by_suffix.get(m.group(1), [])) | set(by_suffix.get(m.group(1) + "/index", [])), key=noext_order.get)
                return [u for k in cands[:2] for u in unit_of_file[by_noext[k]]]
            c = posixpath.normpath(posixpath.join(posixpath.dirname(p), module))
            c = re.sub(r"\.(js|jsx|ts|tsx|mjs|cjs)$", "", c)
            for k in (c, c + "/index"):
                if k in by_noext:
                    return unit_of_file[by_noext[k]]
            return []
        if lang == "go":
            for mod, d in go_mod.items():
                if module == mod or module.startswith(mod + "/"):
                    sub = module[len(mod):].strip("/")
                    target = posixpath.normpath(posixpath.join(d, sub)) if sub else (d or ".")
                    return [u for f in by_dir.get(target if target != "." else "", []) for u in unit_of_file[f]]
            return []
        if lang in ("java", "kotlin"):
            name = module.split(".")[-1]
            return [u for u in sym_units.get(name, []) if nodes[u]["lang"] in ("java", "kotlin")]
        return []

    # ---- edges
    edges = {}
    RANK = {"extends": 6, "implements": 5, "dispatch": 5, "calls": 4, "inject": 3, "imports": 2, "uses": 1}

    def add_edge(s, t, kind, ln=None, path=None):
        if s == t or s not in nodes or t not in nodes:
            return
        e = edges.get((s, t))
        if e is None:
            edges[(s, t)] = {"source": s, "target": t, "kind": kind, "line": ln, "count": 1}
        else:
            e["count"] += 1
            if RANK.get(kind, 0) > RANK.get(e["kind"], 0):
                e["kind"], e["line"] = kind, ln or e["line"]

    calls_out = defaultdict(list)
    unresolved = Counter()
    own_names = {}
    for p, info in parsed.items():
        lang = info.lang
        # name -> candidate units, from imports
        imported = {}
        alias_mod = {}
        for imp in info.imports:
            targets = resolve_module(p, lang, imp["module"])
            if lang == "python" and imp["names"]:
                for name, alias in imp["names"]:
                    sub = resolve_module(p, lang, (imp["module"] + ("" if imp["module"].endswith(".") else ".") + name))
                    if sub:
                        alias_mod[alias or name] = sub
                    elif targets:
                        imported[alias or name] = targets
            elif lang in ("typescript", "tsx", "javascript"):
                for name, alias in imp["names"]:
                    if targets:
                        imported[alias or name] = targets
                if imp.get("alias") and targets:
                    alias_mod[imp["alias"]] = targets
            elif lang == "python" and imp.get("modules"):
                for mod, alias in imp["modules"]:
                    t = resolve_module(p, lang, mod)
                    if t:
                        alias_mod[alias or mod.split(".")[0]] = t
                        alias_mod[mod] = t
            elif lang == "go" and targets:
                alias_mod[imp["alias"] or imp["module"].split("/")[-1]] = targets
            elif lang in ("java", "kotlin") and targets:
                for name, alias in imp["names"]:
                    imported[alias or name] = targets
            for u in unit_of_file[p]:
                for t in targets:
                    add_edge(u, t, "imports", imp["line"])
        same_pkg = set(u for f in by_dir[posixpath.dirname(p)] if f != p for u in unit_of_file[f]) if lang in ("go", "java", "kotlin") else set()

        def candidates(name):
            if name in imported:
                return imported[name]
            if name in sym_units:
                cands = sym_units[name]
                if lang in ("java", "kotlin", "go"):
                    local = [c for c in cands if c in same_pkg] or [c for c in cands if nodes[c]["lang"] == lang]
                    return local if len(local) <= 2 else []
                return list(cands) if len(cands) == 1 else []
            return []

        for c in info.calls:
            src = unit_at(p, c["line"])
            if not src:
                continue
            targets = []
            recv = c["recv"]
            if recv:
                if recv in alias_mod:
                    targets = alias_mod[recv]
                elif recv in info.fields:
                    targets = candidates(info.fields[recv])
                elif recv[:1].isupper():
                    targets = candidates(recv)
                if targets:
                    # keep only targets that define the called name, when we know their symbols
                    narrowed = [t for t in targets if any(s["name"].split(".")[-1] == c["name"] for s in nodes[t]["symbols"])]
                    targets = narrowed or targets
            else:
                targets = candidates(c["name"])
            own = own_names.get(src)
            if own is None:
                own = own_names[src] = {s_["name"].split(".")[-1] for s_ in nodes[src]["symbols"]}
            if c["name"] in own and (recv in (None, "this", "self", "cls", "super") or (recv and recv == nodes[src]["label"])):
                caller = f"{c['type']}.{c['fn']}" if c["type"] and nodes[src]["unitKind"] == "module" else c["fn"]
                calls_out[src].append([caller or "<top>", src, c["name"], c["line"]])
                continue
            targets = [t for t in targets if t != src]
            if not targets:
                if recv is None or recv not in ("this", "self"):
                    unresolved[c["name"]] += 1
                continue
            for t in targets[:2]:
                add_edge(src, t, "calls", c["line"])
                caller = f"{c['type']}.{c['fn']}" if c["type"] and nodes[src]["unitKind"] == "module" else c["fn"]
                calls_out[src].append([caller or "<top>", t, c["name"], c["line"]])
        # type references (Java/Kotlin/TS/Go): weaker "uses" edges
        for name, cnt in info.typerefs.items():
            for t in candidates(name):
                u = unit_of_file[p][0] if unit_of_file[p] else None
                if u:
                    add_edge(u, t, "uses")
        # injected dependencies: fields and constructor parameters with known types
        for fname, ftype in info.fields.items():
            for t in candidates(ftype):
                for u in unit_of_file[p]:
                    add_edge(u, t, "inject")

    for nid, n in nodes.items():
        for t in n["extends"]:
            for u in sym_units.get(t, []):
                add_edge(nid, u, "extends")
        for t in n["implements"]:
            for u in sym_units.get(t, []):
                add_edge(nid, u, "implements")
                # callers that depend on the interface reach the implementation at runtime
                if nodes[u].get("unitKind") == "interface" or nodes[u]["unitKind"] == "module":
                    add_edge(u, nid, "dispatch")

    # ---- collapse empty package initialisers (__init__.py, index.ts, mod.rs) into what they re-export
    for nid in [k for k, n in nodes.items() if n["unitKind"] == "module" and not n["symbols"]
                and os.path.splitext(os.path.basename(n["path"]))[0] in ("__init__", "index", "mod")]:
        ins = [e for e in edges.values() if e["target"] == nid]
        outs = [e for e in edges.values() if e["source"] == nid]
        for a in ins:
            for b in outs:
                add_edge(a["source"], b["target"], "imports", a["line"])
        for k in [k for k in edges if nid in k]:
            del edges[k]
        for k, lst in calls_out.items():
            calls_out[k] = [c for c in lst if c[1] != nid]
        unit_of_file[nodes[nid]["path"]].remove(nid)
        del nodes[nid]

    # ---- layers
    layer_rules = [(re.compile(r["match"]), r["layer"]) for r in cfg.get("layers", [])]
    for nid, n in nodes.items():
        text = parsed[n["path"]].text
        segment = "\n".join(parsed[n["path"]].lines[n["line"] - 1:n["end"]]) if n["unitKind"] != "module" else text
        layer = None
        for rx, lay in layer_rules:
            if rx.search(n["path"]) or rx.search(n["id"]):
                layer = lay
                break
        if not layer:
            annos = {re.sub(r"[@(].*", "", d.lstrip("@")).split(".")[-1] for d in n["decorators"]}
            anno_layer = next((lay for a, lay in ANNO_LAYER.items() if a in annos), None)
            rel = n["path"][len(n["component"]) + 1:] if n["component"] not in (".", "") and n["path"].startswith(n["component"] + "/") else n["path"]
            stem = os.path.splitext(rel)[0] + ("/" + n["label"] if n["unitKind"] != "module" else "")
            path_layer = next((lay for rx, lay in PATH_LAYER if rx.search(stem)), None)
            if UI_PATH.search(n["path"]) and path_layer in (None, "interface", "logic", "service", "util"):
                path_layer = "ui"
            # a framework stereotype like @Service is generic; a name like *Mapper or a repository/ folder is more telling
            if anno_layer and not (anno_layer == "service" and path_layer in ("mapper", "data", "client", "interface", "job")):
                layer = anno_layer
            else:
                layer = path_layer or anno_layer
        n["outbound"] = bool(OUTBOUND.search(segment))
        if n["outbound"] and layer in (None, "service", "logic", "util", "data"):
            layer = "client"
        if n["unitKind"] in ("interface", "enum", "record", "annotation_type", "type") and layer in (None, "logic"):
            layer = "model"
        n["layer"] = layer or "logic"

    # ---- entry points: routes, triggers, mains
    entry_nodes = {}

    def add_entry(eid, label, kind, unit, ln, detail=None, handler=None):
        base = eid
        k = 2
        while eid in entry_nodes and entry_nodes[eid]["target"] != unit:
            eid = f"{base} ({k})"
            k += 1
        entry_nodes[eid] = {"id": eid, "label": label, "type": "entry", "entryKind": kind, "layer": "entry",
                            "path": nodes[unit]["path"], "line": ln, "component": nodes[unit]["component"],
                            "target": unit, "detail": detail, "handler": handler}

    for p, info in parsed.items():
        prefix = ""
        for rx in CLASS_PREFIX:
            m = rx.search(info.text)
            if m:
                prefix = m.group(1)
                break
        m = PY_ROUTER_PREFIX.search(info.text)
        if m:
            prefix = m.group(1)
        for d, dl, fn, owner in info.decos:
            unit = unit_at(p, dl)
            if not unit:
                continue
            for rx, style in ROUTE_DECO:
                m = rx.search(d)
                if not m:
                    continue
                if style == "spring":
                    verb, sub = m.group(1).upper(), m.group(2) or ""
                elif style == "spring-req":
                    if fn is None:
                        break
                    verb, sub = (m.group(2) or "ANY").upper(), m.group(1) or ""
                elif style == "pydeco":
                    verb, sub = m.group(1).upper(), m.group(2)
                    verb = "ANY" if verb in ("ROUTE", "API_ROUTE") else verb
                else:
                    if fn is None:
                        break
                    verb, sub = m.group(1).upper(), m.group(2) or ""
                route = "/" + "/".join(x.strip("/") for x in (prefix, sub) if x.strip("/"))
                add_entry(f"ep:{verb} {route}", f"{verb} {route}", "http", unit, dl, handler=fn)
                break
            for rx, kind in TRIGGER_DECO:
                m = rx.search(d)
                if m and fn:
                    detail = d.strip()[:120]
                    lbl = {"schedule": "schedule", "task": "task", "consumer": "consumer"}[kind]
                    add_entry(f"trg:{unit}.{fn}", f"{lbl}: {fn}", kind, unit, dl, detail=detail, handler=fn)
                    break
        for i, ln_text in enumerate(info.lines, 1):
            m = ROUTE_CALL.search(ln_text) or GO_HANDLEFUNC.search(ln_text)
            unit = unit_at(p, i)
            if m and unit:
                if m.re is GO_HANDLEFUNC:
                    verb, route = "ANY", m.group(2)
                else:
                    verb, route = m.group(2).upper(), m.group(3)
                    verb = "ANY" if verb in ("ALL", "HANDLE", "HANDLEFUNC") else verb
                if route.startswith("/") or route.startswith(":"):
                    add_entry(f"ep:{verb} {route}", f"{verb} {route}", "http", unit, i)
            if info.lang == "python" and os.path.basename(p) == "urls.py":
                m = DJANGO_PATH.search(ln_text)
                if m and unit:
                    view = m.group(3).split(".")[0]
                    add_entry(f"ep:ANY /{m.group(2)}", f"ANY /{m.group(2)}", "http", unit, i, handler=m.group(3))
            for rx, kind in TRIGGER_CALL:
                if unit and rx.search(ln_text):
                    add_entry(f"trg:{unit}:{i}", f"{kind}: {os.path.basename(p)}:{i}", kind, unit, i, detail=ln_text.strip()[:120])
        nm = NEXT_API.search(p) or NEXT_ROUTE.search(p)
        if nm and unit_of_file.get(p):
            route = "/" + ("api/" if nm.re is NEXT_API else "") + re.sub(r"\([^/]*\)/?", "", nm.group(1))
            route = re.sub(r"/index$", "", route).rstrip("/") or "/"
            verbs = [f["name"] for f in info.funcs if f["name"] in ("GET", "POST", "PUT", "PATCH", "DELETE")] or ["ANY"]
            for v in verbs:
                add_entry(f"ep:{v} {route}", f"{v} {route}", "http", unit_of_file[p][0], 1)
        am = APP_CTOR.search(info.text)
        if am and unit_of_file.get(p):
            ln = info.text[:am.start()].count("\n") + 1
            u = unit_at(p, ln) or unit_of_file[p][0]
            add_entry(f"app:{u}", f"{am.group(2).split('.')[0]} app: {nodes[u]['label']}", "app", u, ln, detail=am.group(0).strip()[:120])
        main_m = (re.search(r"^if\s+__name__\s*==\s*[\"']__main__[\"']", info.text, re.M) or
                  (info.lang == "go" and re.search(r"^package\s+main\b", info.text, re.M) and re.search(r"^func\s+main\s*\(", info.text, re.M)) or
                  re.search(r"public\s+static\s+void\s+main\s*\(", info.text) or re.search(r"^fun\s+main\s*\(", info.text, re.M))
        if main_m and unit_of_file.get(p):
            ln = info.text[:main_m.start()].count("\n") + 1
            add_entry(f"cli:{unit_of_file[p][0]}", f"main: {nodes[unit_of_file[p][0]]['label']}", "main", unit_at(p, ln) or unit_of_file[p][0], ln)

    for eid, e in entry_nodes.items():
        nodes[eid] = e
        edges[(eid, e["target"])] = {"source": eid, "target": e["target"], "kind": "routes" if e["entryKind"] == "http" else "triggers", "line": e["line"], "count": 1}
        u = nodes[e["target"]]
        if e["entryKind"] == "app":
            edges[(eid, e["target"])]["kind"] = "triggers"
            continue
        if u["layer"] in ("logic", "service", "util", "data", "client") and e["entryKind"] == "http":
            u["layer"] = "interface"
        if u["layer"] in ("logic", "service", "util") and e["entryKind"] in ("schedule", "task", "consumer"):
            u["layer"] = "job"

    # ---- tables (SQL DDL + ORM declarations)
    tables, history = {}, defaultdict(list)
    sql_files = [p for p in files if p.endswith(".sql") and not TEST_PATH.search(p) and in_scope(p)]

    def migration_order(p):
        m = re.search(r"(?:^|/)V?(\d+)[_.-]", os.path.basename(p))
        return (int(m.group(1)) if m else 10**9, p)

    alive = {}
    for p in sorted(sql_files, key=migration_order):
        try:
            sql = open(os.path.join(root, p), encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        ver = os.path.basename(p)
        for m in SQL_CREATE.finditer(sql):
            t = m.group(1).lower()
            alive[t] = True
            history[t].append({"file": p, "line": sql[:m.start()].count("\n") + 1, "action": "create", "migration": ver})
        for m in SQL_ALTER.finditer(sql):
            t = m.group(1).lower()
            if m.group(3):
                new = m.group(3).lower()
                alive[new], alive[t] = True, False
                history[new] += history.pop(t, []) + [{"file": p, "line": sql[:m.start()].count("\n") + 1, "action": f"renamed from {t}", "migration": ver}]
            elif t in alive:
                history[t].append({"file": p, "line": sql[:m.start()].count("\n") + 1, "action": "alter", "migration": ver})
        for m in SQL_DROP.finditer(sql):
            t = m.group(1).lower()
            alive[t] = False
            history[t].append({"file": p, "line": sql[:m.start()].count("\n") + 1, "action": "drop", "migration": ver})
    orm_owner = {}
    for nid, n in list(nodes.items()):
        if n["type"] != "unit":
            continue
        text = parsed[n["path"]].text if n["unitKind"] == "module" else "\n".join(parsed[n["path"]].lines[max(0, n["line"] - 6):n["end"]])
        for rx in ORM_TABLE:
            for m in rx.finditer(text):
                t = m.group(1).lower()
                alive.setdefault(t, True)
                orm_owner[t] = nid
    for t, ok in alive.items():
        if not ok or len(t) < 3:
            continue
        tid = f"table:{t}"
        tables[tid] = {"id": tid, "label": t, "type": "table", "layer": "table", "component": "database",
                       "history": history.get(t, []),
                       "path": (history[t][0]["file"] if history.get(t) else nodes[orm_owner[t]]["path"] if t in orm_owner else None),
                       "line": (history[t][0]["line"] if history.get(t) else nodes[orm_owner[t]]["line"] if t in orm_owner else None)}
    nodes.update(tables)
    for t, owner in orm_owner.items():
        if f"table:{t}" in nodes:
            add_edge(owner, f"table:{t}", "maps")
            edges[(owner, f"table:{t}")]["kind"] = "maps"
    # Prisma: model names map to tables (@@map), and code reaches them as prisma.<camelModel>.<op>(...)
    prisma_model = {}
    for pf in [f for f in files if f.endswith(".prisma") and in_scope(f)]:
        try:
            ptxt = open(os.path.join(root, pf), encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        for m in re.finditer(r"^model\s+(\w+)\s*\{(.*?)^\}", ptxt, re.M | re.S):
            mm = re.search(r"@@map\(\s*\"(\w+)\"", m.group(2))
            tname = (mm.group(1) if mm else m.group(1)).lower()
            prisma_model[m.group(1)[0].lower() + m.group(1)[1:]] = tname
            if f"table:{tname}" not in nodes and len(tname) >= 3:
                nodes[f"table:{tname}"] = {"id": f"table:{tname}", "label": tname, "type": "table", "layer": "table", "component": "database",
                                          "history": [], "path": pf, "line": ptxt[:m.start()].count("\n") + 1}
                tables[f"table:{tname}"] = nodes[f"table:{tname}"]
    SQL_HINT = re.compile(r"(?i)\b(select|insert|update|delete|from|where|join|table|query|sql|knex|selectFrom|insertInto|deleteFrom|"
                          r"execute|raw|clickhouse|db\.|\.from\(|\.table\(|\.into\(|cursor)\b")
    table_rx = {}
    for tid, t in tables.items():
        name = re.escape(t["label"])
        table_rx[tid] = (re.compile(r"(?i:\b(?:from|into|update|join|table|exists)\s+[\"`]?(?:\w+\.)?" + name + r"\b)"),
                         re.compile(r"[\"'`]" + name + r"[\"'`]"), re.compile(r"(?<![\w.])" + re.escape(t["label"].upper()) + r"\b"))
    prisma_rx = re.compile(r"\bprisma\.(\w+)\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|create|createMany|update|updateMany|"
                           r"upsert|delete|deleteMany|count|aggregate|groupBy)\b")
    for nid, n in list(nodes.items()):
        if n["type"] != "unit" or n["layer"] in ("model", "config", "ui"):
            continue
        lines = parsed[n["path"]].lines[n["line"] - 1:n["end"]] if n["unitKind"] != "module" else parsed[n["path"]].lines
        offset = n["line"] if n["unitKind"] != "module" else 1
        found = {}
        for i, l in enumerate(lines):
            for m in prisma_rx.finditer(l):
                t = prisma_model.get(m.group(1))
                if t and f"table:{t}" in tables:
                    w = m.group(2) not in ("findMany", "findFirst", "findUnique", "findFirstOrThrow", "findUniqueOrThrow", "count", "aggregate", "groupBy")
                    prev = found.get(f"table:{t}")
                    found[f"table:{t}"] = (prev[0] if prev else i + offset, (prev[1] if prev else False) or w)
            hint = SQL_HINT.search(l)
            for tid, (kw, quoted, upper) in table_rx.items():
                if kw.search(l) or (hint and quoted.search(l)) or (n["lang"] in ("java", "kotlin") and upper.search(l)):
                    prev = found.get(tid)
                    found[tid] = (prev[0] if prev else i + offset, (prev[1] if prev else False) or bool(WRITE_WORDS.search(l)))
        for tid, (hit_line, write) in found.items():
            edges[(nid, tid)] = {"source": nid, "target": tid, "kind": "writes" if write else "reads", "line": hit_line, "count": 1}
            if n["layer"] in ("logic", "service", "util"):
                n["layer"] = "data"

    # ---- semantic groups: the feature package a unit lives in, below the component's common source root
    group_rules = [(re.compile(r["match"]), r["group"].strip()) for r in cfg.get("groups", [])]
    by_comp = defaultdict(list)
    for nid, n in nodes.items():
        if n["type"] == "unit":
            by_comp[n["component"]].append(n)
    for comp, units in by_comp.items():
        dirs = [posixpath.dirname(u["path"]) for u in units]
        root_dir = posixpath.commonpath(dirs) if len(set(dirs)) > 1 else (dirs[0] if dirs else "")
        rel = {u["id"]: [x for x in posixpath.dirname(u["path"])[len(root_dir):].split("/") if x] for u in units}
        first = Counter(r[0] if r else "" for r in rel.values())
        big = {seg for seg, c in first.items() if seg and c > max(12, min(40, 0.3 * len(units)))}
        for u in units:
            r = rel[u["id"]]
            g = "/".join(r[:2]) if r and r[0] in big and len(r) >= 2 else (r[0] if r else "")
            for rx, name in group_rules:
                if rx.search(u["path"]) or rx.search(u["id"]):
                    g = name
                    break
            label = g or (posixpath.basename(root_dir) or "root")
            u["group"] = f"{comp}::{label}" if len(by_comp) > 1 else label
            u["groupLabel"] = label

    # ---- infrastructure: config/dependency evidence creates the node, code usage creates the edges
    cfg_files = [p for p in files if INFRA_CONFIG.search(p) and (in_scope(p) or "/" not in p or (scope and p.startswith(scope.split("/")[0] + "/") and p.count("/") <= scope.count("/") + 1))]
    cfg_text = {}
    for p in cfg_files:
        try:
            if os.path.getsize(os.path.join(root, p)) < 400_000:
                cfg_text[p] = open(os.path.join(root, p), encoding="utf-8", errors="replace").read().split("\n")
        except OSError:
            pass
    infra_nodes = {}
    for iid, label, kind, cfg_rx, code_rx in INFRA:
        rx = re.compile(cfg_rx, re.I)
        ev = next(((p, i + 1, l.strip()) for p in sorted(cfg_text, key=lambda x: (not in_scope(x), x)) for i, l in enumerate(cfg_text[p])
                   if rx.search(l) and not re.match(r"\s*(#|//|<!--)", l)), None)
        if not ev:
            continue
        if kind == "database" and any(n["kind"] == "database" for n in infra_nodes.values()) and iid in ("mysql",) and "postgres" in infra_nodes:
            continue
        infra_nodes[f"infra:{iid}"] = {"id": f"infra:{iid}", "label": label, "type": "infra", "kind": kind, "layer": "external",
                                       "component": "infrastructure", "path": ev[0], "line": ev[1], "evidence": ev[2][:160], "code_rx": code_rx}
    primary_db = next((k for k, v in infra_nodes.items() if v["kind"] == "database" and k != "infra:cassandra"), None)
    queue_ids = [k for k, v in infra_nodes.items() if v["kind"] == "queue"]
    for nid, n in list(nodes.items()):
        if n["type"] != "unit":
            continue
        info = parsed[n["path"]]
        lines = info.lines[n["line"] - 1:n["end"]] if n["unitKind"] != "module" else info.lines
        off = n["line"] if n["unitKind"] != "module" else 1
        text = "\n".join(lines)
        for iid, inode in infra_nodes.items():
            crx = re.compile(inode["code_rx"])
            hit = next(((i + off, l) for i, l in enumerate(lines) if crx.search(l) and not re.match(r"\s*(import|from|#|//|\*)", l)), None)
            if not hit:
                continue
            k = inode["kind"]
            if k == "queue":
                consume = re.search(r"Listener|consume|subscribe|@Bean", hit[1]) and not PUBLISH_WORDS.search(hit[1])
                key = (iid, nid) if consume else (nid, iid)
                edges[key] = {"source": key[0], "target": key[1], "kind": "consumes" if consume else "publishes", "line": hit[0], "count": 1}
            elif k == "auth":
                edges[(nid, iid)] = {"source": nid, "target": iid, "kind": "auth", "line": hit[0], "count": 1}
            else:
                wrx = INFRA_WRITE.get(k, WRITE_WORDS)
                whit = next((i + off for i, l in enumerate(lines) if wrx.search(l) and not re.match(r"\s*(import|from|#|//|\*)", l)), None)
                edges[(nid, iid)] = {"source": nid, "target": iid, "kind": "writes" if whit else "reads", "line": whit or hit[0], "count": 1}
        # repositories from another module, injected by type: they reach the primary database
        if primary_db and (nid, primary_db) not in edges:
            ext_repo = [(f, t) for f, t in info.fields.items() if t.endswith("Repository") and not sym_units.get(t)]
            if ext_repo and n["unitKind"] != "module":
                m = re.search(r"\b" + re.escape(ext_repo[0][1]) + r"\b", text)
                ln = off + text[:m.start()].count("\n") if m else n["line"]
                edges[(nid, primary_db)] = {"source": nid, "target": primary_db, "kind": "reads", "line": ln, "count": 1}
        # Spring Cloud Stream functional beans: Consumer/Function consume from the broker, Supplier publishes
        if queue_ids:
            for m in FUNCTION_BEAN.finditer(text):
                ln = off + text[:m.start()].count("\n")
                q = queue_ids[0]
                if m.group(1) == "Supplier":
                    edges[(nid, q)] = {"source": nid, "target": q, "kind": "publishes", "line": ln, "count": 1}
                    continue
                edges[(q, nid)] = {"source": q, "target": nid, "kind": "consumes", "line": ln, "count": 1}
                if m.group(1) == "Function":
                    edges[(nid, q)] = {"source": nid, "target": q, "kind": "publishes", "line": ln, "count": 1}
                eid = f"trg:{nid}.{m.group(2)}"
                if eid not in nodes:
                    nodes[eid] = {"id": eid, "label": f"consumer: {m.group(2)}", "type": "entry", "entryKind": "consumer", "layer": "entry",
                                  "path": n["path"], "line": ln, "component": n["component"], "target": nid, "detail": m.group(0).strip()[:120], "handler": m.group(2)}
                    edges[(eid, nid)] = {"source": eid, "target": nid, "kind": "triggers", "line": ln, "count": 1}
                    entry_nodes[eid] = nodes[eid]
                    if n["layer"] in ("logic", "service", "util", "config"):
                        n["layer"] = "job"
    for inode in infra_nodes.values():
        inode.pop("code_rx", None)
    nodes.update(infra_nodes)
    # tables belong to the primary database
    if primary_db:
        for tid in tables:
            nodes[tid]["db"] = primary_db

    # ---- tests: link test files to the units they import or name
    unit_names = {n["label"].split("/")[-1]: nid for nid, n in nodes.items() if n["type"] == "unit" and len(n["label"]) >= 4}
    tests_by = defaultdict(list)
    plain_names = {k: v for k, v in unit_names.items() if re.fullmatch(r"\w+", k)}
    other_names = [(k, v) for k, v in unit_names.items() if k not in plain_names]
    for tp in test_files:
        try:
            tt = open(os.path.join(root, tp), encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        head = "\n".join(l for l in tt.split("\n") if re.match(r"\s*(import|from|require|use|#include|const .*require)\b", l))
        base = re.sub(r"(_test|\.test|\.spec|Tests?|IT|_spec)$", "", os.path.splitext(os.path.basename(tp))[0]).replace("test_", "")
        hits = set()
        if base in unit_names:
            hits.add(unit_names[base])
        words = set(re.findall(r"\w+", head))
        for name, nid in plain_names.items():
            if name in words:
                hits.add(nid)
        for name, nid in other_names:
            if name in head and re.search(r"\b" + re.escape(name) + r"\b", head):  # substring check first: same result, far fewer regex runs
                hits.add(nid)
        for h in hits:
            tests_by[h].append({"path": tp, "kind": "integration" if re.search(r"IT\.|integration|e2e", tp, re.I) else "unit"})
    for nid, ts in tests_by.items():
        nodes[nid]["tests"] = sorted(ts, key=lambda t: t["path"])[:12]

    # ---- git history
    commits_by_file = defaultdict(list)
    cur = None
    for l in git(root, "log", "-n", "4000", "--no-merges", "--format=@@%h\t%ad\t%an\t%s", "--date=short", "--name-only").splitlines():
        if l.startswith("@@"):
            h, d, a, s = (l[2:].split("\t", 3) + ["", "", ""])[:4]
            cur = {"hash": h, "date": d, "author": a, "subject": s}
        elif l.strip() and cur:
            commits_by_file[l.strip()].append(cur)
    for n in nodes.values():
        if n["type"] != "unit":
            continue
        cs = commits_by_file.get(n["path"], [])
        n["commits"] = len(cs)
        n["lastChanged"] = cs[0]["date"] if cs else None
        n["maintainers"] = [a for a, _ in Counter(c["author"] for c in cs).most_common(3)]
        n["history"] = cs[:6]
        n["tickets"] = sorted({t for c in cs for t in re.findall(r"\b[A-Z][A-Z0-9]{1,9}-\d+\b", c["subject"])})[:12]

    # ---- importance
    ids = list(nodes)
    dep_kinds = {"calls", "inject", "uses", "imports", "dispatch", "reads", "writes", "maps", "routes", "triggers"}
    out_adj = defaultdict(list)
    for (s, t), e in edges.items():
        if e["kind"] in dep_kinds:
            out_adj[s].append(t)
    N = len(ids) or 1
    pr = {i: 1 / N for i in ids}
    for _ in range(50):
        nxt = {i: 0.15 / N for i in ids}
        dangling = sum(pr[i] for i in ids if not out_adj[i])
        for i in ids:
            if out_adj[i]:
                share = 0.85 * pr[i] / len(out_adj[i])
                for t in out_adj[i]:
                    nxt[t] += share
        for i in ids:
            nxt[i] += 0.85 * dangling / N
        pr = nxt

    def reach_from(start, skip_layers=(), cap=3000):
        # capped so very large graphs stay fast; below `cap` reachable nodes the result is exact
        seen, stack = {start}, [start]
        while stack and len(seen) < cap:
            c = stack.pop()
            for t in out_adj[c]:
                if t not in seen and nodes[t]["layer"] not in skip_layers:
                    seen.add(t)
                    stack.append(t)
        return seen

    entries = [i for i in ids if nodes[i]["type"] == "entry"]
    on_path = Counter()
    for e in entries:
        for s in reach_from(e):
            on_path[s] += 1
    fan = {i: len(reach_from(i, ("model", "config", "util"))) - 1 for i in ids}
    maxpr = max(pr.values()) or 1
    maxpath = max(on_path.values(), default=0) or 1
    maxfan = max(fan.values(), default=0) or 1
    maxchurn = max((n.get("commits", 0) for n in nodes.values()), default=0) or 1
    for i in ids:
        n = nodes[i]
        sc = {"depended": round(pr[i] / maxpr, 4), "onPath": round(on_path[i] / maxpath, 4),
              "drives": round(math.sqrt(fan[i] / maxfan), 4), "churn": round(n.get("commits", 0) / maxchurn, 4)}
        lw = LAYER_W.get(n["layer"], 0.4)
        # being imported everywhere makes a helper central, not important to understand first
        dep = sc["depended"] * (0.4 if n["layer"] in ("util", "model", "config", "ui") else 1.0)
        if entries:
            core = 0.25 * sc["onPath"] + 0.2 * dep + 0.25 * sc["drives"] + 0.05 * sc["churn"] + 0.25 * lw
        else:  # a library or tool with no detected entry points: rank by structure alone
            core = 0.3 * dep + 0.35 * sc["drives"] + 0.05 * sc["churn"] + 0.3 * lw
        sc["core"] = round(core, 4)
        n["scores"] = sc
    # An entry point is as important as the handler it reaches, just below it; otherwise a large API's routes
    # (all scored alike) crowd the code out of every "top N" view.
    for i in entries:
        t = nodes[i]["target"]
        if t in nodes and "scores" in nodes[t]:
            per_target = sum(1 for e in entries if nodes[e]["target"] == t)
            nodes[i]["scores"]["core"] = round(nodes[t]["scores"]["core"] * (0.9 if per_target <= 3 else 0.75), 4)
    indeg, outdeg = Counter(), Counter()
    for (s, t) in edges:
        outdeg[s] += 1
        indeg[t] += 1
    for i in ids:
        nodes[i]["inDegree"], nodes[i]["outDegree"] = indeg[i], outdeg[i]
        if i in calls_out:
            nodes[i]["calls"] = calls_out[i][:400]

    # ---- group metrics: size, cohesion and coupling (afferent Ca, efferent Ce, instability Ce/(Ca+Ce))
    gstats = defaultdict(lambda: {"units": 0, "internal": 0, "out": Counter(), "in": Counter(), "layers": Counter(), "infra": Counter()})
    for n in nodes.values():
        if n["type"] == "unit":
            g = gstats[n["group"]]
            g["units"] += 1
            g["layers"][n["layer"]] += 1
            g["label"], g["component"] = n["groupLabel"], n["component"]
    for (s_, t_), e in edges.items():
        a, b = nodes.get(s_, {}).get("group"), nodes.get(t_, {}).get("group")
        if a and b:
            if a == b:
                gstats[a]["internal"] += 1
            elif e["kind"] in ("calls", "inject", "uses", "imports", "dispatch", "extends", "implements"):
                gstats[a]["out"][b] += 1
                gstats[b]["in"][a] += 1
        elif a and t_ in infra_nodes:
            gstats[a]["infra"][t_] += 1
        elif b and s_ in infra_nodes:
            gstats[b]["infra"][s_] += 1
    groups = []
    for gid, g in gstats.items():
        ce, ca = len(g["out"]), len(g["in"])
        ext = sum(g["out"].values())
        groups.append({"id": gid, "label": g["label"], "component": g["component"], "units": g["units"], "internal": g["internal"],
                       "ca": ca, "ce": ce, "instability": round(ce / (ca + ce), 2) if ca + ce else 0.0,
                       "cohesion": round(g["internal"] / (g["internal"] + ext), 2) if g["internal"] + ext else 1.0,
                       "layer": next((l for l, _ in top(g["layers"]) if l not in ("model", "util", "config")), top(g["layers"], 1)[0][0]),
                       "dependsOn": dict(top(g["out"], 12)),
                       "usedBy": dict(top(g["in"], 12)), "infra": dict(sorted(g["infra"].items()))})
    groups.sort(key=lambda g: -g["units"])

    # ---- components summary
    comps = defaultdict(lambda: {"units": 0, "langs": Counter()})
    for n in nodes.values():
        if n["type"] == "unit":
            comps[n["component"]]["units"] += 1
            comps[n["component"]]["langs"][n["lang"]] += 1
    components = []
    for cid, c in sorted(comps.items()):
        mf = next((m for m in MANIFESTS if os.path.exists(os.path.join(root, cid if cid != "." else "", m))), None)
        components.append({"id": cid, "label": os.path.basename(cid) if cid != "." else os.path.basename(root), "path": cid,
                           "manifest": mf, "units": c["units"], "language": top(c["langs"], 1)[0][0]})

    # ---- embed sources, most important first, under a size cap
    budget = args.max_embed_kb * 1024
    ranked_paths = []
    for n in sorted(nodes.values(), key=lambda n: -n["scores"]["core"]):
        if n.get("path") and n["path"] not in ranked_paths:
            ranked_paths.append(n["path"])
    for p in sql_files + [p for p in files if re.search(r"(^|/)(application[\w-]*\.(ya?ml|properties)|settings\.py|openapi[\w.-]*\.(ya?ml|json)|[\w-]*openapi\.(ya?ml|json)|docker-compose[\w.-]*\.ya?ml)$", p) and in_scope(p)]:
        if p not in ranked_paths:
            ranked_paths.append(p)
    for p in parsed:
        if p not in ranked_paths:
            ranked_paths.append(p)
    sources, used, redacted = {}, 0, 0
    for p in ranked_paths:
        try:
            t = parsed[p].text if p in parsed else open(os.path.join(root, p), encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        is_code = os.path.splitext(p)[1] in EXT_LANG
        if SECRET_FILE.search(p) and not is_code:
            continue
        t, n_red = redact(t, code=is_code)
        redacted += n_red
        size = len(t.encode("utf-8"))
        if used + size > budget:
            continue
        sources[p] = t
        used += size
    for n in nodes.values():
        if n.get("path"):
            n["embedded"] = n["path"] in sources

    head = git(root, "rev-parse", "HEAD").strip()
    remote = git(root, "remote", "get-url", "origin").strip()
    m = re.match(r"(?:git@|https://)([^/:]+)[/:](.+?)(?:\.git)?$", remote)
    repo_url = f"https://{m.group(1)}/{m.group(2)}" if m else None
    dirty = bool(git(root, "status", "--porcelain", "--untracked-files=no").strip())
    tree_state = tree_fingerprint(root)
    graph = {
        "schema": SCHEMA, "repo": os.path.basename(root), "root": root, "scope": scope or None,
        "commit": head[:9], "commitFull": head, "commitDate": git(root, "log", "-1", "--format=%ad", "--date=short").strip(),
        "dirty": dirty, "treeState": tree_state, "repoUrl": repo_url, "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "languages": dict(lang_count), "layers": [{"id": a, "label": b, "lane": c} for a, b, c in LAYERS],
        "components": components, "groups": groups, "nodes": list(nodes.values()),
        "edges": sorted(edges.values(), key=lambda e: (e["source"], e["target"], e.get("kind", ""))),
        "stats": {"files": len(main_files), "parsed": len(parsed), "tests": len(test_files), "embeddedKB": round(used / 1024),
                  "embeddedFiles": len(sources), "skippedFromEmbed": len(ranked_paths) - len(sources),
                  "unresolvedCalls": sum(unresolved.values()), "redactedValues": redacted},
    }

    prev = None
    gpath = os.path.join(out, "graph.json")
    if os.path.exists(gpath):
        try:
            with open(gpath) as fh:
                prev = json.load(fh)
        except (OSError, ValueError):
            prev = None
    with open(gpath, "w") as fh:
        json.dump(graph, fh, separators=(",", ":"))
    with open(os.path.join(out, "sources.json"), "w") as fh:
        json.dump(sources, fh, separators=(",", ":"))

    # ---- report for the agent
    units = [n for n in nodes.values() if n["type"] == "unit"]
    print(f"repo {graph['repo']} @ {graph['commit']}{' (uncommitted changes present)' if dirty else ''}{' scope ' + scope if scope else ''}")
    print(f"languages: {dict(lang_count)}  units: {len(units)}  entries: {len(entries)}  tables: {len(tables)}  edges: {len(edges)}")
    print(f"components: {len(components)} -> " + ", ".join(f"{c['id']} ({c['units']})" for c in components[:15]) + (" ..." if len(components) > 15 else ""))
    print(f"embedded sources: {len(sources)} files, {graph['stats']['embeddedKB']} KB (cap {args.max_embed_kb} KB, {graph['stats']['skippedFromEmbed']} files left out, {redacted} secret-looking values redacted)")
    print("layers: " + ", ".join(f"{k}={v}" for k, v in Counter(n["layer"] for n in nodes.values()).most_common()))
    print(f"groups ({len(groups)}): " + ", ".join(f"{g['label']} ({g['units']}, cohesion {g['cohesion']})" for g in groups[:20]) + (" ..." if len(groups) > 20 else ""))
    print("infrastructure: " + (", ".join(f"{v['label']} [{v['kind']}] from {v['path']}:{v['line']} ({sum(1 for k in edges if v['id'] in k)} links)" for v in infra_nodes.values()) or "none detected"))
    print("\nentry points:")
    for e in sorted(entries)[:40]:
        print(f"  {e} -> {nodes[e]['target']}  ({nodes[e]['path']}:{nodes[e]['line']})")
    print("\ntop 30 by core importance:")
    for n in sorted(nodes.values(), key=lambda n: -n["scores"]["core"])[:30]:
        print(f"  {n['scores']['core']:.3f}  {n['layer']:9} {n['id']}  in={n['inDegree']} out={n['outDegree']}")
    orphans = [n["id"] for n in units if n["inDegree"] == 0 and n["layer"] not in ("interface", "job", "config")
               and not any(e["target"] == n["id"] for e in entry_nodes.values())]
    print(f"\nunits nothing in this scope references ({len(orphans)}): " + ", ".join(orphans[:25]) + (" ..." if len(orphans) > 25 else ""))
    print(f"unresolved call names (top): " + ", ".join(f"{k}x{v}" for k, v in unresolved.most_common(12)))
    if prev and prev.get("commitFull") != head:
        old = {n["id"] for n in prev.get("nodes", [])}
        new = {n["id"] for n in nodes.values()}
        print(f"\nchanged since {prev.get('commit')}: +{len(new - old)} nodes, -{len(old - new)} nodes")
        for x in sorted(new - old)[:20]:
            print(f"  + {x}")
        for x in sorted(old - new)[:20]:
            print(f"  - {x}")
        r = subprocess.run(["git", "-C", root, "diff", "--name-only", prev.get("commitFull", ""), head], capture_output=True, text=True)
        if r.returncode == 0:
            print(f"files changed since {prev.get('commit')}: {len(r.stdout.splitlines())}")
        else:
            print(f"file-level diff against {prev.get('commit')} is unavailable (commit not in this clone); use the node changes above")


if __name__ == "__main__":
    main()
