<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';
function unity_check(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}
$hash = str_repeat('a',64);
$guid = str_repeat('b',32);
$fields = [
    ['name'=>'title','kind'=>'string','default'=>'Bloc'],
    ['name'=>'amount','kind'=>'int','min'=>0],
    ['name'=>'icon','kind'=>'asset','type'=>'UnityEngine.Sprite'],
    ['name'=>'drops','kind'=>'list','element'=>['name'=>'element','kind'=>'object','fields'=>[
        ['name'=>'weight','kind'=>'float'],['name'=>'target','kind'=>'asset','type'=>'TilesClass'],
    ]]],
    ['name'=>'mode','kind'=>'enum','options'=>[['name'=>'Normal','value'=>10],['name'=>'Rare','value'=>20]]],
];
$snapshot = [
    'schema_hash'=>$hash,
    'schema'=>['families'=>array_map(fn($type)=>['type'=>$type,'fields'=>$fields],PIXELBOARD_ITEM_TYPES)],
    'assets'=>[['guid'=>$guid,'file_id'=>'9223372036854775806','type'=>'UnityEngine.Sprite','name'=>'Image','types'=>['UnityEngine.Object']]],
    'items'=>[],
];
unity_check(pb_unity_snapshot_valid($snapshot),'recursive schema and subasset fileID accepted');
unity_check(!pb_unity_snapshot_valid(array_merge($snapshot,['schema_hash'=>'invalid'])),'invalid hash rejected');
$bad=$snapshot;
$bad['schema']['families'][0]['fields'][0]['kind']='executable';
unity_check(!pb_unity_snapshot_valid($bad),'unknown schema kind rejected');
$values=['title'=>'Pierre','amount'=>1,'icon'=>['guid'=>$guid,'file_id'=>'9223372036854775806'],'drops'=>[['weight'=>1.5,'target'=>['item_id'=>'new-id']]],'mode'=>10];
$batch=['new-id'=>['type'=>'TilesClass']];
unity_check(pb_unity_value_errors($fields,$values,$snapshot,$batch)===[],'nested typed fields and same-batch reference accepted');
$bad=$values;$bad['hiddenCommand']='unsafe';
unity_check(count(pb_unity_value_errors($fields,$bad,$snapshot,$batch))>0,'unknown field blocks import');
$bad=$values;$bad['mode']=0;
unity_check(count(pb_unity_value_errors($fields,$bad,$snapshot,$batch))>0,'enum numeric value not index required');
$bad=$values;$bad['icon']['file_id']=9223372036854775806;
unity_check(count(pb_unity_value_errors($fields,$bad,$snapshot,$batch))>0,'numeric fileID rejected');
$bad=$values;$bad['amount']=-1;
unity_check(count(pb_unity_value_errors($fields,$bad,$snapshot,$batch))>0,'range checked');
unity_check(count(pb_unity_value_errors($fields,$values,$snapshot,[]))>0,'missing same-batch dependency rejected');
$bad=$fields;$bad[0]['kind']='unsupported';
unity_check(count(pb_unity_value_errors($bad,$values,$snapshot,$batch))>0,'unsupported preserved value blocks import');
$catalogue=['id'=>'__items__:project','projectId'=>'project','recordType'=>'item-catalogue','schemaHash'=>$hash,'schema'=>$snapshot['schema'],'items'=>[],'definitions'=>[
    ['id'=>'item','type'=>'TilesClass','name'=>'Pierre','values'=>$values,'schemaHash'=>$hash,'revision'=>1,'archived'=>false,'unity'=>null],
]];
unity_check(pb_catalogue_valid($catalogue),'typed catalogue accepted');
$bad=$catalogue;$bad['projectId']='other';
unity_check(!pb_catalogue_valid($bad),'project/catalogue identity mismatch rejected');
$bad=$catalogue;$bad['definitions'][]=$bad['definitions'][0];
unity_check(!pb_catalogue_valid($bad),'duplicate item ids rejected');
unity_check(!pb_catalogue_valid(['id'=>'root','items'=>[['type'=>'item-ref','projectId'=>'p','itemId'=>'../other']]]),'invalid card identity rejected');
$bad=$snapshot;$bad['schema']['families'][0]['fields'][0]['name']='__proto__';
unity_check(!pb_unity_snapshot_valid($bad),'prototype-sensitive field rejected');
$bad=$snapshot;$bad['assets'][0]['types']='invalid';
unity_check(!pb_unity_snapshot_valid($bad),'invalid base-type index rejected');
$empty=['schema'=>['families'=>[['type'=>'TilesClass','fields'=>[
    ['name'=>'nested','kind'=>'object','fields'=>[],'default'=>[]],
    ['name'=>'list','kind'=>'list','element'=>['name'=>'element','kind'=>'object','fields'=>[]]],
]]]],'items'=>[['type'=>'TilesClass','values'=>['nested'=>[],'list'=>[[]]]]]];
$encoded=json_decode(json_encode(pb_unity_wire_shape($empty),JSON_THROW_ON_ERROR),false,512,JSON_THROW_ON_ERROR);
unity_check($encoded->items[0]->values->nested instanceof stdClass,'empty object preserved');
unity_check(is_array($encoded->items[0]->values->list),'list stays JSON array');
unity_check($encoded->items[0]->values->list[0] instanceof stdClass,'empty nested list object preserved');
unity_check($encoded->schema->families[0]->fields[0]->default instanceof stdClass,'object default preserved');
$approved=['items'=>$catalogue['definitions']];
$reported=['items'=>[['id'=>'item','status'=>'succeeded','guid'=>$guid,'file_id'=>'9223372036854775806','fingerprint'=>$hash]]];
$changed=$catalogue;$changed['definitions'][0]['values']['title']='Edited while import pending';
$reconciled=pb_unity_reconcile_result($changed,$approved,$reported);
unity_check($reconciled['changed'] && !$reconciled['notes'],'successful new item bound to original canonical id');
unity_check($reconciled['catalogue']['definitions'][0]['unity']['guid']===$guid,'result binds guid');
unity_check($reconciled['catalogue']['definitions'][0]['values']['title']==='Edited while import pending','later member edits preserved');
unity_check(count($reconciled['catalogue']['definitions'])===1,'result does not duplicate canonical item');
$reported['items'][0]['status']='partial';
unity_check(!pb_unity_reconcile_result($catalogue,$approved,$reported)['changed'],'partial writes never treated as success');
$reported['items'][0]['status']='succeeded';$reported['items'][0]['id']='unknown';
unity_check(count(pb_unity_reconcile_result($catalogue,$approved,$reported)['notes'])===1,'unrecognized identity explicitly reported');
$bad=$catalogue;$bad['definitions'][0]['illustration']='data:image/svg+xml;base64,AAAA';
unity_check(!pb_catalogue_valid($bad),'active illustration format rejected');
$good=$catalogue;$good['definitions'][0]['illustration']='data:image/png;base64,AAAA';
unity_check(pb_catalogue_valid($good),'bounded passive illustration accepted');
unity_check(pixelboard_valid_backup_records([['board_id'=>$catalogue['id'],'data'=>json_encode($catalogue,JSON_THROW_ON_ERROR)]]),'catalogue preserved in protected backup records');
unity_check(pixelboard_valid_backup_records([['board_id'=>'root','data'=>json_encode(['id'=>'root','items'=>[['id'=>'ref','type'=>'item-ref','projectId'=>'project','itemId'=>'item']]],JSON_THROW_ON_ERROR)]]),'linked card preserved in protected backup records');
echo "Unity protocol helper tests passed.\n";
