$ErrorActionPreference = "Stop"

# OmniRoute health check helper.
# Reports gateway + provider health from localhost:20128 without exposing credentials.
# Exit codes:
#   0 = gateway online and responding with models
#   2 = gateway unreachable
#   3 = gateway online but reported an unhealthy/empty state
# Uses the /v1/models endpoint (same one the Portable/installed launchers probe).

$url = "http://localhost:20128/v1/models"
$gateway = "http://localhost:20128/v1/models"

try {
  $response = Invoke-RestMethod -Uri $gateway -Method Get -TimeoutSec 3
  $models = @($response.data)
  if ($models.Count -eq 0) {
    Write-Host "OMNIROUTE_GATEWAY=online"
    Write-Host "OMNIROUTE_PROVIDER=unknown (no models reported)"
    Write-Host "OMNIROUTE_STATUS=unhealthy"
    exit 3
  }
  Write-Host "OMNIROUTE_GATEWAY=online"
  Write-Host "OMNIROUTE_MODELS=$($models.Count)"
  Write-Host "OMNIROUTE_STATUS=healthy"
  exit 0
} catch {
  Write-Host "OMNIROUTE_GATEWAY=offline"
  Write-Host "OMNIROUTE_STATUS=unreachable"
  exit 2
}
