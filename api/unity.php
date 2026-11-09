<?php
declare(strict_types=1);
require_once __DIR__ . '/unity-lib.php';

final class PixelboardUnityError extends RuntimeException
{
    public function __construct(public readonly int $status, string $message) { parent::__construct($message); }
}

function pb_unity_reject(int $status, string $message): never
{
    throw new PixelboardUnityError($status, $message);
}

function pb_unity_query(PDO $db, string $sql, array $params = []): PDOStatement
{
    $query = $db->prepare($sql);
    $query->execute($params);
    return $query;
}

function pb_unity_job(array $job): array
{
    return [
        'id' => $job['id'], 'kind' => $job['kind'], 'state' => $job['state'],
        'expires_at' => $job['expires_at'], 'payload_hash' => $job['payload_hash'],
        'payload' => json_decode($job['payload'], false, 512, JSON_THROW_ON_ERROR),
    ];
}

function pb_unity_active_job(PDO $db, array $project, string $id, bool $requireOwner = true): array
{
    $job = pb_unity_query($db, 'SELECT * FROM unity_jobs WHERE workspace_id = ? AND project_id = ? AND id = ? FOR UPDATE',
        [$project['workspace_id'], $project['project_id'], $id])->fetch();
    if (!$job) pb_unity_reject(404, 'Demande Unity introuvable.');
    if (!in_array($job['state'], ['queued', 'claimed'], true) || strtotime($job['expires_at'] . ' UTC') <= time()) {
        pb_unity_reject(409, 'Demande annulée, expirée ou déjà terminée.');
    }
    if ($requireOwner && $job['kind'] === 'import') {
        $role = pb_unity_query($db, 'SELECT role FROM users WHERE workspace_id = ? AND id = ?', [$project['workspace_id'], $job['created_by']])->fetchColumn();
        if ($role !== 'owner') pb_unity_reject(403, 'L’administrateur ayant validé l’import n’est plus habilité.');
    }
    return $job;
}

function pb_unity_handle(PDO $db, string $action, string $method): never
{
    if (empty($_SERVER['HTTPS']) || $_SERVER['HTTPS'] === 'off') pixelboard_fail(403, 'La liaison Unity exige HTTPS.');
    $allowedGet = $action === 'unity-state';
    if (($allowedGet && $method !== 'GET') || (!$allowedGet && $method !== 'POST')) pixelboard_fail(405, 'Méthode Unity non autorisée.');
    $input = $method === 'POST' ? pixelboard_body() : $_GET;
    $projectId = $input['project_id'] ?? '';
    if (!pb_unity_id($projectId) || strlen($projectId) > 60) pixelboard_fail(422, 'Identifiant de projet Unity invalide.');
    $editorActions = ['unity-pair-claim','unity-publish','unity-poll','unity-authorize','unity-result'];
    $editor = in_array($action, $editorActions, true);
    $user = null;
    if (!$editor) {
        $user = pixelboard_require_user($db);
        if ($method === 'POST') pixelboard_require_csrf();
        if ($action !== 'unity-state' && !($action === 'unity-request' && ($input['kind'] ?? '') === 'refresh')) pixelboard_require_owner($user);
    } elseif (($input['protocol'] ?? null) !== 1) {
        pixelboard_fail(422, 'Version du protocole Unity non compatible.');
    }
    try {
        if ($action === 'unity-pair-create') {
            $name = trim((string) ($input['project_name'] ?? ''));
            if ($name === '' || strlen($name) > 120) pb_unity_reject(422, 'Nom de projet requis (120 caractères maximum).');
            $installed=(int)$db->query("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('unity_projects','unity_jobs')")->fetchColumn();
            if ($installed!==2) {
                // Only an authenticated owner with CSRF may install these additive tables.
                foreach (explode(';', file_get_contents(__DIR__ . '/unity-schema.sql')) as $sql) {
                    if (trim($sql) !== '') $db->exec($sql);
                }
            }
            $db->beginTransaction();
            pb_unity_query($db, 'SELECT id FROM workspaces WHERE id = ? FOR UPDATE', [$user['workspace_id']]);
            $code = bin2hex(random_bytes(24));
            pb_unity_query($db, "INSERT INTO unity_projects (workspace_id,project_id,project_name,owner_id,pair_hash,pair_expires)
                VALUES (?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))
                ON DUPLICATE KEY UPDATE project_name=VALUES(project_name),owner_id=VALUES(owner_id),pair_hash=VALUES(pair_hash),
                pair_expires=VALUES(pair_expires),token_hash=NULL", [$user['workspace_id'],$projectId,$name,$user['id'],hash('sha256',$code)]);
            pb_unity_query($db, "UPDATE unity_jobs SET state='cancelled' WHERE workspace_id=? AND project_id=? AND state IN ('queued','claimed')", [$user['workspace_id'],$projectId]);
            $db->commit();
            pixelboard_reply(201, ['pair_code'=>$code,'expires_at'=>gmdate('c',time()+600)]);
        }
        $exists = $db->query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='unity_projects'")->fetchColumn();
        if (!$exists) pb_unity_reject(503, 'Liaison Unity non installée. Un administrateur doit créer un appairage.');
        $db->beginTransaction();
        if ($action === 'unity-pair-claim') {
            $code = $input['pair_code'] ?? '';
            if (!is_string($code) || !preg_match('/^[a-f0-9]{48}$/D',$code)) pb_unity_reject(403,'Code d’appairage invalide.');
            $project = pb_unity_query($db, 'SELECT * FROM unity_projects WHERE project_id=? AND pair_hash=? FOR UPDATE', [$projectId,hash('sha256',$code)])->fetch();
            if (!$project || strtotime($project['pair_expires'] . ' UTC') <= time()) pb_unity_reject(403,'Code d’appairage invalide ou expiré.');
        } elseif ($editor) {
            $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
            if (!preg_match('/^Bearer ([a-f0-9]{64})$/D',$header,$match)) pb_unity_reject(401,'Jeton Unity requis.');
            $project = pb_unity_query($db, 'SELECT * FROM unity_projects WHERE project_id=? AND token_hash=? FOR UPDATE', [$projectId,hash('sha256',$match[1])])->fetch();
            if (!$project) pb_unity_reject(401,'Liaison Unity révoquée ou inconnue.');
        } else {
            $project = pb_unity_query($db, 'SELECT * FROM unity_projects WHERE workspace_id=? AND project_id=? FOR UPDATE', [$user['workspace_id'],$projectId])->fetch();
            if (!$project) pb_unity_reject(404,'Projet non appairé à cet espace.');
        }
        $workspace = (int) $project['workspace_id'];
        if ($editor) {
            $owner = pb_unity_query($db,'SELECT role FROM users WHERE workspace_id=? AND id=?',[$workspace,$project['owner_id']])->fetchColumn();
            if ($owner !== 'owner') pb_unity_reject(403,'Le compte ayant appairé ce projet n’est plus administrateur.');
        }
        if ($action === 'unity-pair-claim') {
            $token = bin2hex(random_bytes(32));
            pb_unity_query($db,'UPDATE unity_projects SET token_hash=?,pair_hash=NULL,pair_expires=NULL WHERE workspace_id=? AND project_id=?',[hash('sha256',$token),$workspace,$projectId]);
            $result = ['protocol'=>1,'token'=>$token,'project_id'=>$projectId];
        } elseif ($action === 'unity-revoke') {
            pb_unity_query($db,'UPDATE unity_projects SET token_hash=NULL,pair_hash=NULL,pair_expires=NULL WHERE workspace_id=? AND project_id=?',[$workspace,$projectId]);
            pb_unity_query($db,"UPDATE unity_jobs SET state='cancelled' WHERE workspace_id=? AND project_id=? AND state IN ('queued','claimed')",[$workspace,$projectId]);
            $result = ['revoked'=>true];
        } elseif ($action === 'unity-state') {
            pb_unity_query($db,"UPDATE unity_jobs SET state='expired' WHERE workspace_id=? AND project_id=? AND state IN ('queued','claimed') AND expires_at<=UTC_TIMESTAMP()",[$workspace,$projectId]);
            $jobs = pb_unity_query($db,'SELECT id,kind,state,result,catalogue_notes,created_at,expires_at FROM unity_jobs WHERE workspace_id=? AND project_id=? ORDER BY created_at DESC LIMIT 30',[$workspace,$projectId])->fetchAll();
            foreach ($jobs as &$job) {
                $job['result'] = $job['result'] ? json_decode($job['result'],false,512,JSON_THROW_ON_ERROR) : null;
                $job['catalogue_notes'] = $job['catalogue_notes'] ? json_decode($job['catalogue_notes'],true,512,JSON_THROW_ON_ERROR) : [];
            }
            unset($job);
            $result = ['protocol'=>1,'project'=>['id'=>$projectId,'name'=>$project['project_name'],'paired'=>$project['token_hash']!==null,'published_at'=>$project['published_at']],
                'snapshot'=>$project['snapshot'] ? json_decode($project['snapshot'],false,512,JSON_THROW_ON_ERROR) : null,'jobs'=>$jobs];
        } elseif ($action === 'unity-publish') {
            $snapshot = $input['snapshot'] ?? null;
            if (!pb_unity_snapshot_valid($snapshot)) pb_unity_reject(422,'Schéma ou index Unity non compatible avec le protocole v1.');
            $json = json_encode(pb_unity_wire_shape($snapshot),JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_PRESERVE_ZERO_FRACTION|JSON_THROW_ON_ERROR);
            if (strlen($json)>32*1024*1024) pb_unity_reject(413,'Instantané Unity trop volumineux (32 Mio).');
            pb_unity_query($db,'UPDATE unity_projects SET snapshot=?,snapshot_hash=?,published_at=UTC_TIMESTAMP() WHERE workspace_id=? AND project_id=?',[$json,hash('sha256',$json),$workspace,$projectId]);
            $result = ['accepted'=>true];
        } elseif ($action === 'unity-request') {
            if (!pb_unity_id($input['request_id']??null) || !in_array($input['kind']??'', ['refresh','import'],true)) pb_unity_reject(422,'Demande Unity invalide.');
            $old = pb_unity_query($db,'SELECT id,state,kind FROM unity_jobs WHERE workspace_id=? AND project_id=? AND request_id=?',[$workspace,$projectId,$input['request_id']])->fetch();
            if ($old) {
                if ($old['kind']!==$input['kind']) pb_unity_reject(409,'Identifiant d’opération déjà utilisé.');
                $result = ['job_id'=>$old['id'],'state'=>$old['state']];
            } else {
                if (!$project['token_hash']) pb_unity_reject(409,'Connecteur Unity non appairé ou révoqué.');
                $snapshot = $project['snapshot'] ? json_decode($project['snapshot'],true,512,JSON_THROW_ON_ERROR) : null;
                $items = [];
                if ($input['kind']==='import') {
                    if (!$snapshot) pb_unity_reject(409,'Publiez d’abord les champs Unity.');
                    // Same workspace lock as normal board writes and protected restores.
                    pb_unity_query($db,'SELECT id FROM workspaces WHERE id=? FOR UPDATE',[$workspace]);
                    $catalogue = pb_unity_query($db,'SELECT data,version FROM boards WHERE workspace_id=? AND board_id=? FOR UPDATE',[$workspace,'__items__:'.$projectId])->fetch();
                    if (!$catalogue || (int)$catalogue['version']!==($input['catalogue_version']??null)) pb_unity_reject(409,'Catalogue modifié ailleurs. Rechargez avant de valider un import.');
                    $data = json_decode($catalogue['data'],true,512,JSON_THROW_ON_ERROR);
                    if (!pb_catalogue_valid($data)) pb_unity_reject(422,'Catalogue incohérent.');
                    $ids = $input['item_ids']??[];
                    if (!is_array($ids)||!$ids||count($ids)>100) pb_unity_reject(422,'Sélectionnez 1 à 100 items distincts.');
                    foreach ($ids as $itemId) if (!pb_unity_id($itemId)) pb_unity_reject(422,'Identifiant d’item invalide.');
                    if (count(array_unique($ids))!==count($ids)) pb_unity_reject(422,'Sélectionnez des items distincts.');
                    foreach ($data['definitions'] as $item) if (in_array($item['id'],$ids,true)) {
                        unset($item['illustration'], $item['lastUnityValues']);
                        $items[]=$item;
                    }
                    if (count($items)!==count($ids)) pb_unity_reject(422,'Item absent du catalogue.');
                    $batch = array_column($items,null,'id');
                    foreach ($items as $item) {
                        if ($item['archived'] || $item['schemaHash']!==$snapshot['schema_hash']) pb_unity_reject(409,'Item archivé ou schéma Unity modifié. Vérifiez les champs avant import.');
                        $family = array_values(array_filter($snapshot['schema']['families'],fn($family)=>$family['type']===$item['type']))[0];
                        $errors = pb_unity_value_errors($family['fields'],$item['values'],$snapshot,$batch);
                        if ($errors) pb_unity_reject(422,$item['name'].' : '.implode(' ',array_slice($errors,0,8)));
                        if ($item['unity']) {
                            $matching = array_values(array_filter($snapshot['items'],fn($entry)=>$entry['guid']===$item['unity']['guid']&&$entry['file_id']===$item['unity']['file_id']));
                            if (!$matching || $matching[0]['fingerprint']!==$item['unity']['fingerprint'] || $matching[0]['type']!==$item['type']) pb_unity_reject(409,'Asset Unity modifié ou manquant. Comparez les versions avant import.');
                        }
                    }
                }
                $payload = ['protocol'=>1,'project_id'=>$projectId,'snapshot_hash'=>$project['snapshot_hash'],'schema_hash'=>$snapshot['schema_hash']??null,'schema'=>$snapshot['schema']??null,'items'=>$items];
                $json=json_encode(pb_unity_wire_shape($payload),JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_PRESERVE_ZERO_FRACTION|JSON_THROW_ON_ERROR);
                $id=pb_unity_uuid();
                $activeCount=(int)pb_unity_query($db,"SELECT COUNT(*) FROM unity_jobs WHERE workspace_id=? AND project_id=? AND state IN ('queued','claimed')",[$workspace,$projectId])->fetchColumn();
                if ($activeCount>=20) pb_unity_reject(429,'Trop de demandes Unity en attente. Terminez ou annulez les demandes.');
                pb_unity_query($db,"INSERT INTO unity_jobs (id,workspace_id,project_id,request_id,created_by,kind,payload,payload_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),DATE_ADD(UTC_TIMESTAMP(),INTERVAL 24 HOUR))",
                    [$id,$workspace,$projectId,$input['request_id'],$user['id'],$input['kind'],$json,hash('sha256',$json)]);
                $result=['job_id'=>$id,'state'=>'queued'];
            }
        } elseif ($action === 'unity-poll') {
            pb_unity_query($db,"UPDATE unity_jobs SET state='expired' WHERE workspace_id=? AND project_id=? AND state IN ('queued','claimed') AND expires_at<=UTC_TIMESTAMP()",[$workspace,$projectId]);
            $job=pb_unity_query($db,"SELECT * FROM unity_jobs WHERE workspace_id=? AND project_id=? AND state IN ('claimed','queued') ORDER BY (state='claimed') DESC, created_at,id LIMIT 1 FOR UPDATE",[$workspace,$projectId])->fetch();
            if ($job) {
                pb_unity_active_job($db,$project,$job['id']);
                pb_unity_query($db,"UPDATE unity_jobs SET state='claimed' WHERE id=?",[$job['id']]);
                $job['state']='claimed';
            }
            $result=['job'=>$job?pb_unity_job($job):null];
        } elseif ($action === 'unity-authorize') {
            $job=pb_unity_active_job($db,$project,(string)($input['job_id']??''));
            if ($job['state']!=='claimed') pb_unity_reject(409,'Demande non prise en charge.');
            $result=['authorized'=>true,'payload'=>json_decode($job['payload'],false,512,JSON_THROW_ON_ERROR),'payload_hash'=>$job['payload_hash']];
        } elseif ($action === 'unity-cancel') {
            $job=pb_unity_active_job($db,$project,(string)($input['job_id']??''),false);
            pb_unity_query($db,"UPDATE unity_jobs SET state='cancelled' WHERE id=?",[$job['id']]);
            $result=['cancelled'=>true];
        } elseif ($action === 'unity-result') {
            $job=pb_unity_query($db,'SELECT * FROM unity_jobs WHERE workspace_id=? AND project_id=? AND id=? FOR UPDATE',[$workspace,$projectId,$input['job_id']??''])->fetch();
            $state=$input['state']??'';
            if (!$job||!in_array($state,['succeeded','failed','declined'],true)||!is_array($input['result']['items']??null)||count($input['result']['items'])>100) pb_unity_reject(422,'Résultat Unity invalide.');
            foreach ($input['result']['items'] as $entry) if (!is_array($entry)) pb_unity_reject(422,'Résultat d’item invalide.');
            $json=json_encode($input['result'],JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR);
            if (strlen($json)>1024*1024) pb_unity_reject(413,'Résultat Unity trop volumineux.');
            if ($job['result']!==null) {
                if ($job['state']!==$state||$job['result']!==$json) pb_unity_reject(409,'Résultat terminal différent déjà enregistré.');
            } else {
                if ($job['state']==='queued') pb_unity_reject(409,'Demande non prise en charge.');
                $notes = [];
                if ($job['kind']==='import') {
                    pb_unity_query($db,'SELECT id FROM workspaces WHERE id=? FOR UPDATE',[$workspace]);
                    $stored=pb_unity_query($db,'SELECT data,version FROM boards WHERE workspace_id=? AND board_id=? FOR UPDATE',[$workspace,'__items__:'.$projectId])->fetch();
                    if ($stored) {
                        $catalogue=json_decode($stored['data'],true,512,JSON_THROW_ON_ERROR);
                        if (!pb_catalogue_valid($catalogue)) pb_unity_reject(409,'Catalogue incohérent; résultat conservé dans Unity en attente de rapprochement.');
                        $reconciled=pb_unity_reconcile_result($catalogue,json_decode($job['payload'],true,512,JSON_THROW_ON_ERROR),$input['result']);
                        $notes=$reconciled['notes'];
                        if ($reconciled['changed']) pb_unity_query($db,'UPDATE boards SET data=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE workspace_id=? AND board_id=?',
                            [json_encode(pb_unity_wire_shape($reconciled['catalogue']),JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_PRESERVE_ZERO_FRACTION|JSON_THROW_ON_ERROR),$workspace,'__items__:'.$projectId]);
                    } else $notes[]='Catalogue absent; comparez les assets Unity pour récupérer les items importés.';
                }
                // Accept late reports of actual writes even after expiry/cancel; never reauthorize them.
                pb_unity_query($db,'UPDATE unity_jobs SET state=?,result=?,catalogue_notes=? WHERE id=?',[$state,$json,json_encode($notes,JSON_THROW_ON_ERROR),$job['id']]);
            }
            $result=['accepted'=>true,'state'=>$state];
        } else pb_unity_reject(404,'Action Unity inconnue.');
        $db->commit();
        pixelboard_reply(200,$result);
    } catch (PixelboardUnityError $error) {
        if ($db->inTransaction()) $db->rollBack();
        pixelboard_fail($error->status,$error->getMessage());
    } catch (Throwable $error) {
        if ($db->inTransaction()) $db->rollBack();
        throw $error;
    }
}
