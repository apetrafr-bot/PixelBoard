<?php
declare(strict_types=1);

const PIXELBOARD_ITEM_TYPES = ['TilesClass', 'ToolClass', 'WeaponsClass', 'ArmureClass'];

function pb_unity_id(mixed $id): bool
{
    return is_string($id) && preg_match('/^[a-zA-Z0-9_-]{1,80}$/D', $id) === 1;
}

function pb_unity_hash(mixed $value): bool
{
    return is_string($value) && preg_match('/^[a-f0-9]{64}$/D', $value) === 1;
}

function pb_unity_thumbnail_valid(mixed $value): bool
{
    if ($value === null) return true;
    if (!is_string($value) || strlen($value) > 131072 || !str_starts_with($value, 'data:image/png;base64,')) return false;
    $encoded = substr($value, 22);
    $bytes = base64_decode($encoded, true);
    if ($bytes === false || base64_encode($bytes) !== $encoded || !str_starts_with($bytes, "\x89PNG\r\n\x1a\n")) return false;
    $size = @getimagesizefromstring($bytes);
    return $size !== false && $size[2] === IMAGETYPE_PNG && $size[0] >= 1 && $size[0] <= 128 && $size[1] >= 1 && $size[1] <= 128;
}

function pb_unity_ref(mixed $value): bool
{
    return is_array($value) && is_string($value['guid'] ?? null) && preg_match('/^[a-f0-9]{32}$/D', $value['guid']) === 1
        && is_string($value['file_id'] ?? null) && preg_match('/^-?[0-9]{1,20}$/D', $value['file_id']) === 1;
}

function pb_unity_fields_valid(mixed $fields, int $depth = 0): bool
{
    if (!is_array($fields) || count($fields) > 1024 || $depth > 12) return false;
    $names = [];
    foreach ($fields as $field) {
        if (!is_array($field) || !is_string($field['name'] ?? null)
            || !preg_match('/^[a-zA-Z_][a-zA-Z0-9_]{0,119}$/D', $field['name'])
            || in_array($field['name'], ['__proto__', 'prototype', 'constructor'], true)
            || isset($names[$field['name']])) return false;
        $names[$field['name']] = true;
        if (!in_array($field['kind'] ?? '', ['string','bool','int','float','enum','color','vector2','vector3','vector4','object','list','asset','unsupported'], true)) return false;
        if ($field['kind'] === 'object' && !pb_unity_fields_valid($field['fields'] ?? null, $depth + 1)) return false;
        if ($field['kind'] === 'list' && !pb_unity_fields_valid([$field['element'] ?? null], $depth + 1)) return false;
        foreach (['flags', 'multiline'] as $flag) if (isset($field[$flag]) && !is_bool($field[$flag])) return false;
        if (isset($field['type']) && !is_string($field['type'])) return false;
        foreach (['min', 'max'] as $limit) if (isset($field[$limit]) && (!is_numeric($field[$limit]) || !is_finite((float)$field[$limit]))) return false;
        if ($field['kind'] === 'enum') {
            if (!is_array($field['options'] ?? null) || count($field['options']) > 1024) return false;
            foreach ($field['options'] as $option) {
                if (!is_array($option) || !is_string($option['name'] ?? null) || !is_int($option['value'] ?? null)) return false;
            }
        }
    }
    return true;
}

function pb_unity_schema_valid(mixed $schema): bool
{
    if (!is_array($schema) || !is_array($schema['families'] ?? null)) return false;
    $families = [];
    foreach ($schema['families'] as $family) {
        if (!is_array($family) || !in_array($family['type'] ?? null, PIXELBOARD_ITEM_TYPES, true)
            || isset($families[$family['type']]) || !pb_unity_fields_valid($family['fields'] ?? null)) return false;
        $families[$family['type']] = true;
    }
    return count($families) === 4;
}

function pb_unity_snapshot_valid(mixed $snapshot): bool
{
    if (!is_array($snapshot) || !pb_unity_hash($snapshot['schema_hash'] ?? null)
        || !pb_unity_schema_valid($snapshot['schema'] ?? null)
        || !is_array($snapshot['assets'] ?? null) || !is_array($snapshot['items'] ?? null)
        || count($snapshot['assets']) > 100000 || count($snapshot['items']) > 10000) return false;
    $assets = [];
    foreach ($snapshot['assets'] as $asset) {
        if (!pb_unity_ref($asset) || !is_string($asset['name'] ?? null) || !is_string($asset['type'] ?? null)) return false;
        if (isset($asset['types'])) {
            if (!is_array($asset['types']) || count($asset['types']) > 128) return false;
            foreach ($asset['types'] as $type) if (!is_string($type) || strlen($type) > 1024) return false;
        }
        $key = $asset['guid'] . ':' . $asset['file_id'];
        if (isset($assets[$key])) return false;
        $assets[$key] = true;
    }
    $items = [];
    foreach ($snapshot['items'] as $item) {
        if (!pb_unity_ref($item) || !isset($assets[$item['guid'] . ':' . $item['file_id']])
            || !in_array($item['type'] ?? null, PIXELBOARD_ITEM_TYPES, true) || !pb_unity_hash($item['fingerprint'] ?? null)
            || !is_string($item['name'] ?? null) || !is_array($item['values'] ?? null)) return false;
        if (!pb_unity_thumbnail_valid($item['thumbnail'] ?? null)) return false;
        $key = $item['guid'] . ':' . $item['file_id'];
        if (isset($items[$key])) return false;
        $items[$key] = true;
    }
    return true;
}

function pb_catalogue_valid(array $data): bool
{
    $id = (string) ($data['id'] ?? '');
    if (str_starts_with($id, '__items__:') || ($data['recordType'] ?? '') === 'item-catalogue') {
        if (!pb_unity_id($data['projectId'] ?? null) || $id !== '__items__:' . $data['projectId']
            || ($data['recordType'] ?? '') !== 'item-catalogue' || ($data['items'] ?? null) !== []
            || !is_array($data['definitions'] ?? null) || count($data['definitions']) > 10000
            || !pb_unity_hash($data['schemaHash'] ?? null) || !pb_unity_schema_valid($data['schema'] ?? null)) return false;
        $ids = [];
        $identities = [];
        foreach ($data['definitions'] as $item) {
            if (!is_array($item) || !pb_unity_id($item['id'] ?? null) || isset($ids[$item['id']])
                || !in_array($item['type'] ?? '', PIXELBOARD_ITEM_TYPES, true)
                || !is_string($item['name'] ?? null) || strlen($item['name']) > 240
                || !is_array($item['values'] ?? null) || !pb_unity_hash($item['schemaHash'] ?? null)
                || !is_int($item['revision'] ?? null) || $item['revision'] < 1
                || !is_bool($item['archived'] ?? null)) return false;
            if (isset($item['illustration']) && (!is_string($item['illustration']) || strlen($item['illustration']) > 1500000
                || !preg_match('/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+\/]+=*$/D', $item['illustration']))) return false;
            if (!pb_unity_thumbnail_valid($item['unityThumbnail'] ?? null)) return false;
            $ids[$item['id']] = true;
            if (($item['unity'] ?? null) !== null) {
                if (!pb_unity_ref($item['unity']) || !pb_unity_hash($item['unity']['fingerprint'] ?? null)) return false;
                $identity = $item['unity']['guid'] . ':' . $item['unity']['file_id'];
                if (isset($identities[$identity])) return false;
                $identities[$identity] = true;
            }
        }
    }
    foreach ($data['items'] ?? [] as $item) {
        if (!is_array($item)) return false;
        if (($item['type'] ?? '') === 'item-ref'
            && (!pb_unity_id($item['projectId'] ?? null) || !pb_unity_id($item['itemId'] ?? null))) return false;
    }
    return true;
}

function pb_unity_value_errors(array $fields, array $values, array $snapshot, array $batch, string $prefix = ''): array
{
    $errors = [];
    $known = array_column($fields, null, 'name');
    foreach ($values as $name => $value) {
        if (!isset($known[$name])) $errors[] = $prefix . $name . ': champ inconnu (valeur conservée).';
    }
    foreach ($fields as $field) {
        $name = $field['name'];
        $path = $prefix . $name;
        if (!array_key_exists($name, $values)) {
            $errors[] = $path . ': champ manquant.';
            continue;
        }
        $value = $values[$name];
        $kind = $field['kind'];
        $valid = match ($kind) {
            'string' => is_string($value) && strlen($value) <= 100000,
            'bool' => is_bool($value),
            'int', 'enum' => is_int($value),
            'float' => (is_int($value) || is_float($value)) && is_finite((float) $value),
            'object', 'list', 'color', 'vector2', 'vector3', 'vector4' => is_array($value),
            'asset' => $value === null || pb_unity_ref($value) || (is_array($value) && pb_unity_id($value['item_id'] ?? null) && isset($batch[$value['item_id']])),
            default => false,
        };
        if ($valid && in_array($kind, ['int', 'float'], true)) {
            if ((isset($field['min']) && $value < $field['min']) || (isset($field['max']) && $value > $field['max'])) $valid = false;
        }
        if ($valid && $kind === 'enum' && empty($field['flags'])) $valid = in_array($value, array_column($field['options'], 'value'), true);
        if ($valid && $kind === 'asset' && $value !== null) {
            $wanted = $field['type'] ?? '';
            if (isset($value['item_id'])) {
                $valid = ($batch[$value['item_id']]['unity'] ?? null) === null
                    && ($wanted === '' || in_array($wanted, [$batch[$value['item_id']]['type'], 'UnityEngine.Object', 'UnityEngine.ScriptableObject'], true));
            } else {
                $valid = false;
                foreach ($snapshot['assets'] as $asset) {
                    if ($asset['guid'] === $value['guid'] && $asset['file_id'] === $value['file_id']
                        && ($wanted === '' || $asset['type'] === $wanted || in_array($wanted, $asset['types'] ?? [], true))) $valid = true;
                }
            }
        }
        if ($valid && $kind === 'object') $errors = array_merge($errors, pb_unity_value_errors($field['fields'], $value, $snapshot, $batch, $path . '.'));
        if ($valid && $kind === 'list') {
            if (!array_is_list($value) || count($value) > 10000) $valid = false;
            else foreach ($value as $index => $element) {
                $elementField = $field['element'];
                $errors = array_merge($errors, pb_unity_value_errors([$elementField], [$elementField['name'] => $element], $snapshot, $batch, $path . '[' . $index . '].'));
            }
        }
        if ($valid && in_array($kind, ['color', 'vector2', 'vector3', 'vector4'], true)) {
            $components = $kind === 'color' ? ['r','g','b','a'] : array_slice(['x','y','z','w'], 0, (int) substr($kind, -1));
            if (count($value) !== count($components)) $valid = false;
            foreach ($components as $component) {
                if (!isset($value[$component]) || (!is_int($value[$component]) && !is_float($value[$component])) || !is_finite((float) $value[$component])) $valid = false;
            }
        }
        if (!$valid) $errors[] = $path . ': type, référence ou valeur non compatible.';
    }
    return $errors;
}

function pb_unity_value_shape(array $field, mixed $value): mixed
{
    if (!is_array($value)) return $value;
    if ($field['kind'] === 'object') {
        foreach ($field['fields'] as $child) {
            if (array_key_exists($child['name'], $value)) $value[$child['name']] = pb_unity_value_shape($child, $value[$child['name']]);
        }
        return (object)$value;
    }
    if ($field['kind'] === 'list') return array_map(fn($entry) => pb_unity_value_shape($field['element'], $entry), $value);
    if (in_array($field['kind'], ['color', 'vector2', 'vector3', 'vector4'], true)) return (object)$value;
    return $value;
}

function pb_unity_field_shape(array $field): array
{
    if (array_key_exists('default', $field)) $field['default'] = pb_unity_value_shape($field, $field['default']);
    if (isset($field['fields'])) $field['fields'] = array_map('pb_unity_field_shape', $field['fields']);
    if (isset($field['element'])) $field['element'] = pb_unity_field_shape($field['element']);
    return $field;
}

function pb_unity_wire_shape(array $document): array
{
    if (!isset($document['schema']['families'])) return $document;
    $families = array_column($document['schema']['families'], null, 'type');
    $key = ($document['recordType'] ?? '') === 'item-catalogue' ? 'definitions' : 'items';
    foreach ($document[$key] ?? [] as $index => $item) {
        if (isset($item['values']) && is_array($item['values']) && isset($families[$item['type']])) {
            $field = ['kind'=>'object', 'fields'=>$families[$item['type']]['fields']];
            $document[$key][$index]['values'] = pb_unity_value_shape($field, $item['values']);
        }
    }
    foreach ($document['schema']['families'] as &$family) $family['fields'] = array_map('pb_unity_field_shape', $family['fields']);
    unset($family);
    return $document;
}

function pb_unity_reconcile_result(array $catalogue, array $approved, array $result): array
{
    $notes = [];
    $changed = false;
    $items = array_column($approved['items'], null, 'id');
    foreach ($result['items'] ?? [] as $reported) {
        if (!is_array($reported) || ($reported['status'] ?? '') !== 'succeeded') continue;
        $id = $reported['id'] ?? null;
        if (!pb_unity_id($id) || !isset($items[$id]) || !pb_unity_ref($reported) || !pb_unity_hash($reported['fingerprint'] ?? null)) {
            $notes[] = 'Identité de résultat non reconnue; comparaison Unity requise.';
            continue;
        }
        $index = array_search($id, array_column($catalogue['definitions'], 'id'), true);
        if ($index === false) {
            $notes[] = $id . ' : fiche absente (restauration ou suppression); comparez les assets Unity.';
            continue;
        }
        $current = $catalogue['definitions'][$index];
        $original = $items[$id];
        $sameIdentity = fn($left, $right) => $left === null || $right === null
            ? $left === $right : $left['guid'] === $right['guid'] && $left['file_id'] === $right['file_id'];
        $duplicate = array_filter($catalogue['definitions'], fn($entry) => $entry['id'] !== $id && ($entry['unity'] ?? null) !== null
            && $entry['unity']['guid'] === $reported['guid'] && $entry['unity']['file_id'] === $reported['file_id']);
        if ($current['type'] !== $original['type'] || !$sameIdentity($current['unity'], $original['unity'])
            || ($original['unity'] !== null && !$sameIdentity($original['unity'], $reported)) || $duplicate) {
            $notes[] = $id . ' : identité modifiée depuis la validation; rapprochement manuel requis.';
            continue;
        }
        $catalogue['definitions'][$index]['unity'] = array_intersect_key($reported, array_flip(['guid','file_id','fingerprint']));
        $catalogue['definitions'][$index]['lastUnityValues'] = $original['values'];
        $catalogue['definitions'][$index]['revision']++;
        $changed = true;
    }
    return ['catalogue'=>$catalogue,'changed'=>$changed,'notes'=>$notes];
}

function pb_unity_uuid(): string
{
    $hex = bin2hex(random_bytes(16));
    return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-4' . substr($hex, 13, 3) . '-a' . substr($hex, 17, 3) . '-' . substr($hex, 20);
}
