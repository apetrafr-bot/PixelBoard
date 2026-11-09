<?php
declare(strict_types=1);

function pixelboard_log_failure(string $directory, string $diagnostic, Throwable $error): string
{
    $reference = bin2hex(random_bytes(8));
    // Never log exception messages: they can contain credentials or user data.
    $line = gmdate('c') . ' reference=' . $reference . ' diagnostic=' . $diagnostic
        . ' exception=' . get_class($error) . PHP_EOL;
    if ((!is_dir($directory) && !@mkdir($directory, 0700, true))
        || @file_put_contents($directory . '/errors.log', $line, FILE_APPEND | LOCK_EX) === false) {
        error_log('PixelBoard private log unavailable; ' . trim($line));
    }
    return $reference;
}

function pixelboard_valid_email(string $email): bool
{
    return strlen($email) <= 254 && filter_var($email, FILTER_VALIDATE_EMAIL) !== false;
}

function pixelboard_valid_password(string $password): bool
{
    return strlen($password) >= 12 && strlen($password) <= 4096;
}

function pixelboard_user_can_access_workspace(array $user, int $workspaceId): bool
{
    return isset($user['workspace_id']) && (int) $user['workspace_id'] === $workspaceId;
}

function pixelboard_user_can_manage_members(array $user, int $workspaceId): bool
{
    return pixelboard_user_can_access_workspace($user, $workspaceId) && ($user['role'] ?? '') === 'owner';
}

function pixelboard_user_can_edit_member(array $actor, array $target, bool $isProfileOnly): bool
{
    if (!pixelboard_user_can_access_workspace($actor, (int) ($target['workspace_id'] ?? 0))) {
        return false;
    }

    if (($actor['role'] ?? '') === 'owner') {
        return true;
    }

    return $isProfileOnly && (int) ($actor['id'] ?? 0) === (int) ($target['id'] ?? -1);
}

function pixelboard_csrf_matches(string $expected, string $provided): bool
{
    return $expected !== '' && $provided !== '' && hash_equals($expected, $provided);
}

function pixelboard_valid_color(string $color): bool
{
    return preg_match('/^#[0-9a-f]{6}$/i', $color) === 1;
}
