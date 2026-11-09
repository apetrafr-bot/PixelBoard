<?php
declare(strict_types=1);

function pixelboard_install_backups(PDO $db): void
{
    $db->exec("CREATE TABLE IF NOT EXISTS workspace_backups (
        workspace_id BIGINT UNSIGNED NOT NULL,
        slot ENUM('approved', 'before_restore') NOT NULL,
        data LONGTEXT NOT NULL,
        revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
        saved_by BIGINT UNSIGNED NOT NULL,
        saved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workspace_id, slot),
        CONSTRAINT backups_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

function pixelboard_backup_versions_match(array $current, array $expected): bool
{
    ksort($current);
    ksort($expected);
    return $current === $expected;
}

function pixelboard_valid_backup_records(mixed $records): bool
{
    if (!is_array($records) || !$records) return false;
    $ids = [];
    foreach ($records as $record) {
        if (!is_array($record) || !is_string($record['board_id'] ?? null)
            || $record['board_id'] === '' || strlen($record['board_id']) > 80
            || isset($ids[$record['board_id']]) || !is_string($record['data'] ?? null)) return false;
        $data = json_decode($record['data'], true);
        if (!is_array($data) || ($data['id'] ?? null) !== $record['board_id'] || !is_array($data['items'] ?? null)) return false;
        $ids[$record['board_id']] = true;
    }
    return true;
}

function pixelboard_database_diagnostic(Throwable $error): string
{
    $driverCode = $error instanceof PDOException ? (int) ($error->errorInfo[1] ?? 0) : 0;
    return match ($driverCode) {
        1045, 1698 => 'DATABASE_AUTH_REJECTED',
        1044 => 'DATABASE_ACCESS_DENIED',
        1049 => 'DATABASE_UNKNOWN',
        2002, 2003, 2005 => 'DATABASE_UNREACHABLE',
        1040, 1203, 1226 => 'DATABASE_LIMIT',
        default => 'DATABASE_CONNECT',
    };
}

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
