<?php
declare(strict_types=1);

require __DIR__ . '/lib.php';

function check(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, "ÉCHEC : {$message}\n");
        exit(1);
    }
}

$owner = ['id' => 1, 'workspace_id' => 7, 'role' => 'owner'];
$logDirectory = sys_get_temp_dir() . '/pixelboard-test-' . bin2hex(random_bytes(8));
$reference = pixelboard_log_failure($logDirectory, 'CONFIG_SYNTAX', new ParseError('SECRET_MUST_NOT_BE_LOGGED'));
$log = file_get_contents($logDirectory . '/errors.log');
check(str_contains($log, $reference) && str_contains($log, 'CONFIG_SYNTAX'), 'journal lie a la reference publique');
check(!str_contains($log, 'SECRET_MUST_NOT_BE_LOGGED'), 'message sensible exclu du journal');
unlink($logDirectory . '/errors.log');
rmdir($logDirectory);
$member = ['id' => 2, 'workspace_id' => 7, 'role' => 'member'];
$foreignMember = ['id' => 3, 'workspace_id' => 8, 'role' => 'member'];

check(pixelboard_valid_email('artiste@example.fr'), 'adresse e-mail valide acceptée');
check(!pixelboard_valid_email('not-an-email'), 'adresse e-mail invalide refusée');
check(pixelboard_valid_password('CorrectHorseBattery!'), 'mot de passe de 12 caractères accepté');
check(!pixelboard_valid_password('short'), 'mot de passe trop court refusé');
check(pixelboard_user_can_access_workspace($member, 7), 'membre accède à son espace');
check(!pixelboard_user_can_access_workspace($member, 8), 'membre isolé des autres espaces');
check(pixelboard_user_can_manage_members($owner, 7), 'propriétaire gère les membres de son espace');
check(!pixelboard_user_can_manage_members($member, 7), 'membre ne peut pas gérer les membres');
check(pixelboard_user_can_edit_member($member, $member, true), 'membre édite son nom');
check(!pixelboard_user_can_edit_member($member, $member, false), 'membre ne peut pas modifier son tag ou sa couleur');
check(!pixelboard_user_can_edit_member($owner, $foreignMember, false), 'propriétaire isolé des autres espaces');
check(pixelboard_csrf_matches('token-1', 'token-1'), 'jeton CSRF identique accepté');
check(!pixelboard_csrf_matches('token-1', 'token-2'), 'jeton CSRF incorrect refusé');
check(pixelboard_valid_color('#d7f36a'), 'couleur hexadécimale valide acceptée');
check(!pixelboard_valid_color('red'), 'couleur invalide refusée');

echo "Tests de sécurité API réussis.\n";
