<?php
declare(strict_types=1);

require __DIR__ . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');

function pixelboard_reply(int $status, array $payload): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function pixelboard_fail(int $status, string $message): never
{
    pixelboard_reply($status, ['error' => $message]);
}

function pixelboard_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > 64 * 1024 * 1024) {
        pixelboard_fail(413, 'La requête dépasse la limite autorisée.');
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        pixelboard_fail(400, 'Le contenu JSON est invalide.');
    }
    return $data;
}

function pixelboard_db(array $config): PDO
{
    try {
        return new PDO($config['db']['dsn'], $config['db']['username'], $config['db']['password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    } catch (Throwable $error) {
        error_log('PixelBoard database connection failed: ' . $error->getMessage());
        pixelboard_fail(503, 'Le serveur de données est indisponible. Vérifiez la configuration MySQL.');
    }
}

function pixelboard_public_user(PDO $db, int $userId): ?array
{
    $query = $db->prepare('SELECT id, workspace_id, email, display_name, tag, color, role FROM users WHERE id = ?');
    $query->execute([$userId]);
    $user = $query->fetch();
    return $user ?: null;
}

function pixelboard_require_user(PDO $db): array
{
    if (!isset($_SESSION['user_id'], $_SESSION['workspace_id'])) {
        pixelboard_fail(401, 'Connectez-vous pour accéder à cet espace.');
    }
    $user = pixelboard_public_user($db, (int) $_SESSION['user_id']);
    if (!$user || (int) $user['workspace_id'] !== (int) $_SESSION['workspace_id']) {
        $_SESSION = [];
        session_regenerate_id(true);
        pixelboard_fail(401, 'La session n’est plus valide. Reconnectez-vous.');
    }
    return $user;
}

function pixelboard_require_csrf(): void
{
    $provided = (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
    if (!pixelboard_csrf_matches((string) ($_SESSION['csrf_token'] ?? ''), $provided)) {
        pixelboard_fail(403, 'La vérification de sécurité a échoué. Rechargez la page.');
    }
}

function pixelboard_require_owner(array $user): void
{
    if (!pixelboard_user_can_manage_members($user, (int) $user['workspace_id'])) {
        pixelboard_fail(403, 'Seul le propriétaire de l’espace peut effectuer cette action.');
    }
}

function pixelboard_new_csrf(): string
{
    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    return $_SESSION['csrf_token'];
}

function pixelboard_workspace(PDO $db, int $workspaceId): ?array
{
    $query = $db->prepare('SELECT id, name FROM workspaces WHERE id = ?');
    $query->execute([$workspaceId]);
    return $query->fetch() ?: null;
}

function pixelboard_limit_login(PDO $db, string $email, array $config): void
{
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    $key = hash_hmac('sha256', strtolower($email) . '|' . $ip, $config['setup_secret']);
    $db->prepare(
        'INSERT INTO auth_attempts (attempt_key, attempts, window_started_at)
         VALUES (?, 1, NOW())
         ON DUPLICATE KEY UPDATE
           attempts = IF(window_started_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE), 1, attempts + 1),
           window_started_at = IF(window_started_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE), NOW(), window_started_at)'
    )->execute([$key]);
    $query = $db->prepare('SELECT attempts FROM auth_attempts WHERE attempt_key = ?');
    $query->execute([$key]);
    if ((int) $query->fetchColumn() > 10) {
        pixelboard_fail(429, 'Trop de tentatives. Réessayez dans 15 minutes.');
    }
}

function pixelboard_establish_session(array $user): string
{
    session_regenerate_id(true);
    $_SESSION['user_id'] = (int) $user['id'];
    $_SESSION['workspace_id'] = (int) $user['workspace_id'];
    return pixelboard_new_csrf();
}

try {
    $configPath = __DIR__ . '/config.php';
    if (!is_file($configPath)) {
        pixelboard_fail(503, 'Le serveur équipe n’est pas encore configuré.');
    }
    $config = require $configPath;
    if (!is_array($config) || !isset($config['db']['dsn'], $config['db']['username'], $config['db']['password'], $config['setup_secret'])
        || strlen((string) $config['setup_secret']) < 32
        || str_starts_with((string) $config['setup_secret'], 'replace-')) {
        pixelboard_fail(503, 'La configuration serveur est incomplète ou son secret d’installation est trop court.');
    }

    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.use_trans_sid', '0');
    session_name('pixelboard_session');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();

    $db = pixelboard_db($config);
    $action = (string) ($_GET['action'] ?? '');
    $method = (string) ($_SERVER['REQUEST_METHOD'] ?? 'GET');

    if ($action === 'setup' && $method === 'POST') {
        $providedSecret = (string) ($_SERVER['HTTP_X_SETUP_SECRET'] ?? '');
        if (!pixelboard_csrf_matches((string) $config['setup_secret'], $providedSecret)) {
            pixelboard_fail(403, 'Secret d’installation incorrect.');
        }
        $input = pixelboard_body();
        $email = strtolower(trim((string) ($input['email'] ?? '')));
        $password = (string) ($input['password'] ?? '');
        $name = trim((string) ($input['name'] ?? ''));
        $workspaceName = trim((string) ($input['workspace'] ?? ''));
        if (!pixelboard_valid_email($email) || !pixelboard_valid_password($password)
            || $name === '' || strlen($name) > 80 || $workspaceName === '' || strlen($workspaceName) > 120) {
            pixelboard_fail(422, 'Vérifiez le nom, l’adresse e-mail et le mot de passe (12 caractères minimum).');
        }
        $db->beginTransaction();
        try {
            $setupState = $db->query("SELECT initialized FROM system_state WHERE state_key = 'owner_bootstrap' FOR UPDATE")->fetchColumn();
            if ($setupState === false || (int) $setupState !== 0
                || (int) $db->query('SELECT COUNT(*) FROM workspaces')->fetchColumn() !== 0) {
                $db->rollBack();
                pixelboard_fail(409, 'L’espace est déjà initialisé. Utilisez une invitation pour ajouter des membres.');
            }
            $db->prepare('INSERT INTO workspaces (name) VALUES (?)')->execute([$workspaceName]);
            $workspaceId = (int) $db->lastInsertId();
            $db->prepare('INSERT INTO users (workspace_id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)')
                ->execute([$workspaceId, $email, password_hash($password, PASSWORD_DEFAULT), $name, 'owner']);
            $db->prepare("UPDATE system_state SET initialized = 1 WHERE state_key = 'owner_bootstrap'")->execute();
            $db->commit();
        } catch (Throwable $error) {
            if ($db->inTransaction()) {
                $db->rollBack();
            }
            throw $error;
        }
        pixelboard_reply(201, ['message' => 'Espace créé. Connectez-vous pour continuer.']);
    }

    if ($action === 'auth' && $method === 'GET') {
        $csrf = $_SESSION['csrf_token'] ?? pixelboard_new_csrf();
        $user = isset($_SESSION['user_id']) ? pixelboard_public_user($db, (int) $_SESSION['user_id']) : null;
        $workspace = $user ? pixelboard_workspace($db, (int) $user['workspace_id']) : null;
        pixelboard_reply(200, ['user' => $user, 'workspace' => $workspace, 'csrf' => $csrf]);
    }

    if ($action === 'register' && $method === 'POST') {
        pixelboard_require_csrf();
        $input = pixelboard_body();
        $email = strtolower(trim((string) ($input['email'] ?? '')));
        $password = (string) ($input['password'] ?? '');
        $name = trim((string) ($input['name'] ?? ''));
        $code = trim((string) ($input['invite_code'] ?? ''));
        if (!pixelboard_valid_email($email) || !pixelboard_valid_password($password)
            || $name === '' || strlen($name) > 80 || strlen($code) < 24 || strlen($code) > 128) {
            pixelboard_fail(422, 'Vérifiez le formulaire. Le mot de passe doit contenir au moins 12 caractères.');
        }
        $workspaceId = null;
        $invitations = $db->query('SELECT id, join_code_hash FROM workspaces WHERE join_code_hash IS NOT NULL')->fetchAll();
        foreach ($invitations as $invitation) {
            if (password_verify($code, $invitation['join_code_hash'])) {
                $workspaceId = (int) $invitation['id'];
                break;
            }
        }
        if (!$workspaceId) {
            pixelboard_fail(403, 'Code d’invitation invalide ou expiré.');
        }
        try {
            $db->prepare('INSERT INTO users (workspace_id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)')
                ->execute([$workspaceId, $email, password_hash($password, PASSWORD_DEFAULT), $name, 'member']);
        } catch (PDOException $error) {
            if ((string) $error->getCode() === '23000') {
                pixelboard_fail(409, 'Cette adresse e-mail possède déjà un compte.');
            }
            throw $error;
        }
        $user = pixelboard_public_user($db, (int) $db->lastInsertId());
        $csrf = pixelboard_establish_session($user);
        pixelboard_reply(201, [
            'user' => $user,
            'workspace' => pixelboard_workspace($db, $workspaceId),
            'csrf' => $csrf,
        ]);
    }

    if ($action === 'login' && $method === 'POST') {
        pixelboard_require_csrf();
        $input = pixelboard_body();
        $email = strtolower(trim((string) ($input['email'] ?? '')));
        $password = (string) ($input['password'] ?? '');
        pixelboard_limit_login($db, $email, $config);
        $query = $db->prepare('SELECT id, workspace_id, email, password_hash FROM users WHERE email = ?');
        $query->execute([$email]);
        $record = $query->fetch();
        if (!$record || !password_verify($password, $record['password_hash'])) {
            pixelboard_fail(401, 'Adresse e-mail ou mot de passe incorrect.');
        }
        $db->prepare('DELETE FROM auth_attempts WHERE attempt_key = ?')
            ->execute([hash_hmac('sha256', strtolower($email) . '|' . (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown'), $config['setup_secret'])]);
        $user = pixelboard_public_user($db, (int) $record['id']);
        $csrf = pixelboard_establish_session($user);
        pixelboard_reply(200, [
            'user' => $user,
            'workspace' => pixelboard_workspace($db, (int) $user['workspace_id']),
            'csrf' => $csrf,
        ]);
    }

    if ($action === 'logout' && $method === 'POST') {
        pixelboard_require_csrf();
        $_SESSION = [];
        session_regenerate_id(true);
        $csrf = pixelboard_new_csrf();
        pixelboard_reply(200, ['user' => null, 'workspace' => null, 'csrf' => $csrf]);
    }

    $user = pixelboard_require_user($db);
    $workspaceId = (int) $user['workspace_id'];

    if ($action === 'members' && $method === 'GET') {
        $query = $db->prepare('SELECT id, workspace_id, email, display_name, tag, color, role FROM users WHERE workspace_id = ? ORDER BY id');
        $query->execute([$workspaceId]);
        pixelboard_reply(200, ['members' => $query->fetchAll()]);
    }

    if ($action === 'member' && $method === 'PATCH') {
        pixelboard_require_csrf();
        $targetId = filter_var($_GET['id'] ?? null, FILTER_VALIDATE_INT);
        if (!$targetId) {
            pixelboard_fail(400, 'Identifiant de membre invalide.');
        }
        $query = $db->prepare('SELECT id, workspace_id, role FROM users WHERE id = ? AND workspace_id = ?');
        $query->execute([$targetId, $workspaceId]);
        $target = $query->fetch();
        if (!$target) {
            pixelboard_fail(404, 'Membre introuvable dans cet espace.');
        }
        $input = pixelboard_body();
        $profileOnly = count(array_diff(array_keys($input), ['display_name'])) === 0;
        if (!pixelboard_user_can_edit_member($user, $target, $profileOnly)) {
            pixelboard_fail(403, 'Vous ne pouvez modifier que votre nom. Le propriétaire gère les tags et couleurs.');
        }
        $name = trim((string) ($input['display_name'] ?? ''));
        if ($name === '' || strlen($name) > 80) {
            pixelboard_fail(422, 'Le nom doit contenir entre 1 et 80 caractères.');
        }
        if ($profileOnly) {
            $db->prepare('UPDATE users SET display_name = ? WHERE id = ? AND workspace_id = ?')
                ->execute([$name, $targetId, $workspaceId]);
        } else {
            $tag = trim((string) ($input['tag'] ?? ''));
            $color = (string) ($input['color'] ?? '');
            if (strlen($tag) > 40 || !pixelboard_valid_color($color)) {
                pixelboard_fail(422, 'Le tag ou la couleur du membre est invalide.');
            }
            $db->prepare('UPDATE users SET display_name = ?, tag = ?, color = ? WHERE id = ? AND workspace_id = ?')
                ->execute([$name, $tag, $color, $targetId, $workspaceId]);
        }
        pixelboard_reply(200, ['member' => pixelboard_public_user($db, (int) $targetId)]);
    }

    if ($action === 'invite' && $method === 'POST') {
        pixelboard_require_csrf();
        pixelboard_require_owner($user);
        $code = bin2hex(random_bytes(18));
        $db->prepare('UPDATE workspaces SET join_code_hash = ? WHERE id = ?')
            ->execute([password_hash($code, PASSWORD_DEFAULT), $workspaceId]);
        pixelboard_reply(201, ['invite_code' => $code]);
    }

    if ($action === 'boards' && $method === 'GET') {
        $query = $db->prepare('SELECT board_id, data, version, updated_at FROM boards WHERE workspace_id = ? ORDER BY updated_at, board_id');
        $query->execute([$workspaceId]);
        $boards = [];
        foreach ($query->fetchAll() as $record) {
            $data = json_decode($record['data'], true);
            if (!is_array($data)) {
                error_log('PixelBoard found invalid board JSON for workspace ' . $workspaceId);
                pixelboard_fail(500, 'Un tableau enregistré est illisible. Contactez le propriétaire du site.');
            }
            $boards[] = [
                'id' => $record['board_id'],
                'data' => $data,
                'version' => (int) $record['version'],
                'updated_at' => $record['updated_at'],
            ];
        }
        pixelboard_reply(200, ['boards' => $boards]);
    }

    if ($action === 'board' && $method === 'PUT') {
        pixelboard_require_csrf();
        $input = pixelboard_body();
        $id = (string) ($input['id'] ?? '');
        $version = filter_var($input['version'] ?? 0, FILTER_VALIDATE_INT);
        $data = $input['data'] ?? null;
        if ($id === '' || strlen($id) > 80 || $version === false || $version < 0 || !is_array($data) || ($data['id'] ?? null) !== $id
            || !is_array($data['items'] ?? null)) {
            pixelboard_fail(422, 'Les données du tableau sont invalides.');
        }
        $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            pixelboard_fail(422, 'Le tableau ne peut pas être encodé.');
        }
        $db->beginTransaction();
        try {
            $query = $db->prepare('SELECT version FROM boards WHERE workspace_id = ? AND board_id = ? FOR UPDATE');
            $query->execute([$workspaceId, $id]);
            $currentVersion = $query->fetchColumn();
            if ($currentVersion === false) {
                if ($version !== 0) {
                    $db->rollBack();
                    pixelboard_fail(409, 'Le tableau a été modifié ailleurs. Rechargez les données du serveur.');
                }
                $db->prepare('INSERT INTO boards (workspace_id, board_id, data, version) VALUES (?, ?, ?, 1)')
                    ->execute([$workspaceId, $id, $json]);
                $nextVersion = 1;
            } else {
                if ((int) $currentVersion !== $version) {
                    $db->rollBack();
                    pixelboard_fail(409, 'Le tableau a été modifié ailleurs. Vos changements locaux sont conservés dans ce navigateur.');
                }
                $nextVersion = (int) $currentVersion + 1;
                $db->prepare('UPDATE boards SET data = ?, version = ? WHERE workspace_id = ? AND board_id = ?')
                    ->execute([$json, $nextVersion, $workspaceId, $id]);
            }
            $db->commit();
        } catch (Throwable $error) {
            if ($db->inTransaction()) {
                $db->rollBack();
            }
            throw $error;
        }
        pixelboard_reply(200, ['version' => $nextVersion]);
    }

    pixelboard_fail(404, 'Action API inconnue.');
} catch (Throwable $error) {
    error_log('PixelBoard API error: ' . $error->getMessage());
    pixelboard_fail(500, 'Erreur interne du serveur. Consultez le journal PHP pour plus de détails.');
}
