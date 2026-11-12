<?php
declare(strict_types=1);

require __DIR__ . '/lib.php';

final class SessionResponse extends RuntimeException
{
    public function __construct(public int $status, public array $payload)
    {
        parent::__construct((string) ($payload['error'] ?? ''));
    }
}

function pixelboard_reply(int $status, array $payload): never
{
    throw new SessionResponse($status, $payload);
}

$source = file_get_contents(__DIR__ . '/index.php');
$start = strpos($source, 'function pixelboard_require_csrf(): void');
$end = strpos($source, 'function pixelboard_require_owner(', $start);
eval(substr($source, $start, $end - $start));

$_SESSION = ['csrf_token' => 'current-token'];
foreach ([null, 'stale-token'] as $provided) {
    $_SERVER['HTTP_X_CSRF_TOKEN'] = $provided;
    try {
        pixelboard_require_csrf();
        throw new RuntimeException('Invalid CSRF unexpectedly accepted.');
    } catch (SessionResponse $response) {
        if ($response->status !== 403 || ($response->payload['code'] ?? '') !== 'csrf_expired') {
            throw new RuntimeException('CSRF denial must be explicit and distinguishable from permission denial.');
        }
    }
}
$_SERVER['HTTP_X_CSRF_TOKEN'] = 'current-token';
pixelboard_require_csrf();
echo "3 session CSRF checks passed.\n";
