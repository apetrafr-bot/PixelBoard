<?php
declare(strict_types=1);
require __DIR__ . '/unity.php';

final class UnityTestResponse extends RuntimeException
{
    public function __construct(public int $status, public array $body) {}
}
function pixelboard_reply(int $status, array $body): never { throw new UnityTestResponse($status, $body); }
function pixelboard_fail(int $status, string $message): never { pixelboard_reply($status, ['error'=>$message]); }
function pixelboard_body(): array { return $GLOBALS['input']; }
function pixelboard_require_user(PDO $db): array { return $GLOBALS['actor']; }
function pixelboard_require_csrf(): void { if (!$GLOBALS['csrf']) pixelboard_fail(403, 'CSRF'); }
function pixelboard_require_owner(array $user): void { if ($user['role'] !== 'owner') pixelboard_fail(403, 'Owner'); }

final class UnityTestStatement extends PDOStatement
{
    public function __construct(private UnityTestDatabase $db, private string $sql) {}
    private mixed $value = false;
    public function execute(?array $params = null): bool { $this->value = $this->db->dispatch($this->sql, $params ?? []); return true; }
    public function fetch(int $mode = PDO::FETCH_DEFAULT, int $cursorOrientation = PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed { return $this->value; }
    public function fetchColumn(int $column = 0): mixed { return $this->value; }
}
final class UnityTestDatabase extends PDO
{
    private bool $active = false;
    public array $queries = [];
    public bool $revoked = false;
    public string $role = 'owner';
    public array $roles = [];
    public ?array $catalogue = null;
    public int $boardWrites = 0;
    public array $project = ['workspace_id'=>7, 'project_id'=>'project', 'owner_id'=>1];
    public array $job;
    public function __construct()
    {
        $payload = '{"protocol":1,"items":[],"schema":{"empty":{}}}';
        $this->job = ['id'=>'job','kind'=>'import','state'=>'claimed','created_by'=>1,'expires_at'=>gmdate('Y-m-d H:i:s',time()+3600),'payload'=>$payload,'payload_hash'=>hash('sha256',$payload),'result'=>null];
    }
    public function beginTransaction(): bool { $this->active=true; return true; }
    public function commit(): bool { $this->active=false; return true; }
    public function rollBack(): bool { $this->active=false; return true; }
    public function inTransaction(): bool { return $this->active; }
    public function prepare(string $query, array $options = []): PDOStatement|false { return new UnityTestStatement($this,$query); }
    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        $statement=$this->prepare($query); $statement->execute(); return $statement;
    }
    public function dispatch(string $sql, array $params): mixed
    {
        $this->queries[]=[$sql,$params];
        if (str_contains($sql,'information_schema')) return str_contains($sql,'COUNT(*)') ? 2 : 'unity_projects';
        if (str_starts_with($sql,'INSERT INTO unity_projects')) return true;
        if (str_starts_with($sql,'SELECT * FROM unity_projects')) {
            $scoped = str_contains($sql, 'WHERE workspace_id=?')
                ? $params[0] === $this->project['workspace_id'] && $params[1] === $this->project['project_id']
                : $params[0] === $this->project['project_id'];
            return $this->revoked || !$scoped ? false : $this->project;
        }
        if (str_starts_with($sql,'SELECT role')) return $this->roles[$params[1]] ?? $this->role;
        if (str_starts_with($sql,'SELECT * FROM unity_jobs')) return $this->job;
        if (str_starts_with($sql,'SELECT id FROM workspaces')) return 7;
        if (str_starts_with($sql,'SELECT data,version FROM boards')) return $this->catalogue;
        if (str_starts_with($sql,'UPDATE boards SET data=')) {
            $this->catalogue['data']=$params[0];$this->boardWrites++;return true;
        }
        if (str_starts_with($sql,'UPDATE unity_jobs')) {
            if (str_contains($sql,'SET state=?,result=?')) {
                $this->job['state']=$params[0]; $this->job['result']=$params[1];
            }
            return true;
        }
        throw new RuntimeException('Unexpected test query: '.$sql);
    }
}
function route_check(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}
function request(UnityTestDatabase $db, string $action, array $input=[]): UnityTestResponse
{
    $GLOBALS['input']=array_merge(['protocol'=>1,'project_id'=>'project','job_id'=>'job'],$input);
    try { pb_unity_handle($db,'unity-'.$action,'POST'); }
    catch (UnityTestResponse $response) { return $response; }
}
$_SERVER['HTTPS']='on';
$_SERVER['HTTP_AUTHORIZATION']='Bearer '.str_repeat('a',64);
$GLOBALS['actor']=['role'=>'member','workspace_id'=>7,'id'=>2];
$GLOBALS['csrf']=true;
$db=new UnityTestDatabase();
foreach (['pair-create','revoke','cancel'] as $action) route_check(request($db,$action)->status===403,'member cannot '.$action);
route_check(request($db,'request',['kind'=>'import'])->status===403,'member cannot authorize imports');
$GLOBALS['actor']['role']='owner'; $GLOBALS['csrf']=false;
route_check(request($db,'request',['kind'=>'import'])->status===403,'CSRF required');
$GLOBALS['csrf']=true;
route_check(request($db,'pair-create',['project_name'=>'Installed manually'])->status===201,'existing tables need no CREATE privilege');
$GLOBALS['csrf']=true;$GLOBALS['actor']['workspace_id']=99;
route_check(request($db,'cancel')->status===404,'cross-workspace project denied');
$GLOBALS['actor']['workspace_id']=7;
route_check(request($db,'authorize',['project_id'=>'other'])->status===401,'bearer scoped to project');
$GLOBALS['csrf']=true; $_SERVER['HTTPS']='off';
route_check(request($db,'authorize')->status===403,'HTTPS required');
$_SERVER['HTTPS']='on'; $db->revoked=true;
route_check(request($db,'authorize')->status===401,'revoked token denied');
$db->revoked=false; $db->role='member';
route_check(request($db,'authorize')->status===403,'pairing owner must still be owner');
$db->role='owner';
$db->roles[3]='member';$db->job['created_by']=3;
route_check(request($db,'authorize')->status===403,'approving administrator role rechecked separately');
$db->job['created_by']=1;
$approved=request($db,'authorize');
route_check($approved->status===200 && $approved->body['payload_hash']===$db->job['payload_hash'],'approved snapshot hash preserved');
route_check($approved->body['payload']->schema->empty instanceof stdClass,'authorize preserves object JSON shape');
$poll=request($db,'poll');
route_check($poll->body['job']['payload_hash']===$approved->body['payload_hash'],'claimed job retries use same immutable hash');
foreach (['cancelled','expired','succeeded','queued'] as $state) {
    $db->job['state']=$state;
    route_check(request($db,'authorize')->status===409,'cannot authorize '.$state);
}
$db->job['state']='claimed';$db->job['expires_at']='2000-01-01 00:00:00';
route_check(request($db,'authorize')->status===409,'expiry rechecked before writes');
$db->job['expires_at']=gmdate('Y-m-d H:i:s',time()+3600);
$result=['state'=>'failed','result'=>['message'=>'Interrupted; reconciliation required','items'=>[['id'=>'x','status'=>'partial','dirty'=>true]]]];
route_check(request($db,'result',$result)->status===200,'partial dirty actual-write report accepted');
route_check(request($db,'result',$result)->status===200,'exact terminal retry acknowledged');
$result['result']['message']='Different result';
route_check(request($db,'result',$result)->status===409,'changed terminal report denied');
$scoped=array_filter($db->queries,fn($entry)=>str_contains($entry[0],'SELECT * FROM unity_jobs WHERE workspace_id = ? AND project_id = ? AND id = ?'));
route_check(count($scoped)>0 && array_values($scoped)[0][1]===[7,'project','job'],'job queries scoped by workspace/project/id');
$db=new UnityTestDatabase();
$definition=['id'=>'x','type'=>'TilesClass','name'=>'X','values'=>[],'revision'=>1,'schemaHash'=>str_repeat('a',64),'archived'=>false,'unity'=>null];
$catalogue=['id'=>'__items__:project','projectId'=>'project','recordType'=>'item-catalogue','schemaHash'=>str_repeat('a',64),
    'items'=>[],'definitions'=>[$definition],'schema'=>['families'=>array_map(fn($type)=>['type'=>$type,'fields'=>[]],PIXELBOARD_ITEM_TYPES)]];
$db->catalogue=['data'=>json_encode($catalogue,JSON_THROW_ON_ERROR),'version'=>1];
$db->job['payload']=json_encode(['items'=>[$definition]],JSON_THROW_ON_ERROR);
$result=['state'=>'succeeded','result'=>['items'=>[['id'=>'x','status'=>'succeeded','guid'=>str_repeat('b',32),'file_id'=>'11400000','fingerprint'=>str_repeat('c',64)]]]];
route_check(request($db,'result',$result)->status===200,'success bound in terminal result transaction');
route_check(request($db,'result',$result)->status===200 && $db->boardWrites===1,'result retry never writes catalogue twice');
$bound=json_decode($db->catalogue['data'],true,512,JSON_THROW_ON_ERROR);
route_check(count($bound['definitions'])===1 && $bound['definitions'][0]['id']==='x' && $bound['definitions'][0]['unity']['guid']===str_repeat('b',32),'canonical id retained without duplicate');
echo "Unity route guard tests passed (in-memory PDO double; not MySQL integration).\n";
