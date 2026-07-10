param(
  [int]$Port = 47821,
  [string]$OutDir = (Join-Path $env:USERPROFILE ".pxpipe\rollout-observations\pr-98"),
  [int]$Samples = 3,
  [double]$IntervalHours = 24,
  [switch]$WatchForMerge,
  [string]$Repo = "teamchong/pxpipe",
  [int]$Pr = 98
)

$ErrorActionPreference = "Stop"

function Write-JsonFile {
  param([string]$Path, [object]$Value)
  $Value | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Invoke-JsonGet {
  param([string]$Url)
  try {
    $res = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 10
    return ($res.Content | ConvertFrom-Json)
  } catch {
    return [pscustomobject]@{
      error = $_.Exception.Message
      url = $Url
    }
  }
}

function Invoke-PxpipeDoctor {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $distNode = Join-Path $repoRoot "dist\node.js"
  $oldPort = $env:PORT
  try {
    $env:PORT = [string]$Port
    if (Test-Path -LiteralPath $distNode) {
      $raw = & node $distNode doctor --json 2>&1
    } else {
      $raw = & pxpipe doctor --json 2>&1
    }
    if ($LASTEXITCODE -ne 0) {
      return [pscustomobject]@{
        error = "pxpipe doctor failed"
        exit_code = $LASTEXITCODE
        output = ($raw -join "`n")
      }
    }
    return (($raw -join "`n") | ConvertFrom-Json)
  } catch {
    return [pscustomobject]@{
      error = $_.Exception.Message
    }
  } finally {
    if ($null -eq $oldPort) {
      Remove-Item Env:PORT -ErrorAction SilentlyContinue
    } else {
      $env:PORT = $oldPort
    }
  }
}

function Get-Prop {
  param([object]$Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $p = $Object.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

function Select-Metrics {
  param(
    [string]$Label,
    [string]$CapturedAt,
    [object]$Version,
    [object]$Stats,
    [object]$Doctor
  )
  $events = Get-Prop $Doctor "events"
  $summary = Get-Prop $events "summary"
  $flags = Get-Prop $Version "flags"

  return [ordered]@{
    label = $Label
    captured_at = $CapturedAt
    version_git_sha = Get-Prop $Version "git_sha"
    version_dist_sha8 = Get-Prop $Version "dist_sha8"
    routing_shadow = Get-Prop $flags "routing_shadow"
    parsed = Get-Prop $events "parsed"
    dropped = Get-Prop $events "dropped"
    total = Get-Prop $summary "total"
    err400 = Get-Prop $summary "err400"
    refusalEvents = Get-Prop $summary "refusalEvents"
    safetyFlaggedEvents = Get-Prop $summary "safetyFlaggedEvents"
    tier0DroppedTotal = Get-Prop $summary "tier0DroppedTotal"
    tier0DroppedEvents = Get-Prop $summary "tier0DroppedEvents"
    omittedCharsTotal = Get-Prop $summary "omittedCharsTotal"
    cachePrefixEvents = Get-Prop $summary "cachePrefixEvents"
    cachePrefixUnique = Get-Prop $summary "cachePrefixUnique"
    baselineProbeOk = Get-Prop $summary "baselineProbeOk"
    baselineProbePartial = Get-Prop $summary "baselineProbePartial"
    baselineProbeFailed = Get-Prop $summary "baselineProbeFailed"
    routingShadowHeavy = Get-Prop $summary "routingShadowHeavy"
    routingShadowLight = Get-Prop $summary "routingShadowLight"
    saved_pct = Get-Prop $Stats "saved_pct"
    saved_pct_of_all_spend = Get-Prop $Stats "saved_pct_of_all_spend"
    requests = Get-Prop $Stats "requests"
    compressed_requests = Get-Prop $Stats "compressed_requests"
  }
}

function NumericDelta {
  param([object]$First, [object]$Last, [string]$Name)
  $a = Get-Prop $First $Name
  $b = Get-Prop $Last $Name
  if (($null -eq $a) -or ($null -eq $b)) { return "" }
  return [string]([double]$b - [double]$a)
}

function Write-Conclusions {
  param([array]$Rows, [string]$Path)
  $first = $Rows[0]
  $last = $Rows[$Rows.Count - 1]
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("# PXpipe PR #98 rollout observation")
  $lines.Add("")
  $lines.Add("Generated: $(Get-Date -Format o)")
  $lines.Add("")
  $lines.Add("| metric | first | last | delta |")
  $lines.Add("|---|---:|---:|---:|")
  foreach ($name in @(
    "requests",
    "compressed_requests",
    "saved_pct",
    "saved_pct_of_all_spend",
    "err400",
    "refusalEvents",
    "safetyFlaggedEvents",
    "tier0DroppedTotal",
    "tier0DroppedEvents",
    "omittedCharsTotal",
    "cachePrefixEvents",
    "cachePrefixUnique",
    "baselineProbePartial",
    "baselineProbeFailed",
    "routingShadowHeavy",
    "routingShadowLight"
  )) {
    $lines.Add("| $name | $(Get-Prop $first $name) | $(Get-Prop $last $name) | $(NumericDelta $first $last $name) |")
  }
  $lines.Add("")
  $lines.Add("## Decision checklist")
  $lines.Add("")
  $lines.Add("- C9/C10: if routingShadowHeavy/Light stayed zero, rerun with PXPIPE_ROUTING_SHADOW=1 before deciding.")
  $lines.Add("- B6 stash/retrieval: proceed only if tier0Dropped/omitted/fidelity evidence shows a real gap factsheet captions did not close.")
  $lines.Add("- Safety: investigate any post-deploy increase in err400/refusalEvents/safetyFlaggedEvents before enabling new behavior.")
  $lines.Add("- Cache: inspect cachePrefixUnique/cachePrefixEvents for prefix churn before changing routing.")
  $lines | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Wait-ForMerge {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "[pxpipe observe] gh is not available; cannot watch PR merge"
    return
  }
  while ($true) {
    try {
      $raw = gh pr view $Pr --repo $Repo --json state,mergedAt,url
      $prInfo = $raw | ConvertFrom-Json
      if ($prInfo.state -eq "MERGED" -or $prInfo.mergedAt) {
        Write-Host "[pxpipe observe] PR merged: $($prInfo.url)"
        return
      }
      Write-Host "[pxpipe observe] PR not merged yet: state=$($prInfo.state); sleeping 15m"
    } catch {
      Write-Host "[pxpipe observe] PR check failed: $($_.Exception.Message); sleeping 15m"
    }
    Start-Sleep -Seconds 900
  }
}

if ($Samples -lt 1) { throw "Samples must be >= 1" }
if ($IntervalHours -lt 0) { throw "IntervalHours must be >= 0" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if ($WatchForMerge) {
  Wait-ForMerge
}

$rows = @()
for ($i = 0; $i -lt $Samples; $i++) {
  $label = if ($i -eq 0) { "T0" } else { "T+$([int]($i * $IntervalHours))h" }
  $capturedAt = Get-Date -Format o
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  $sampleDir = Join-Path $OutDir "$($i)-$stamp"
  New-Item -ItemType Directory -Force -Path $sampleDir | Out-Null

  Write-Host "[pxpipe observe] capturing $label into $sampleDir"
  $version = Invoke-JsonGet "http://127.0.0.1:$Port/version"
  $stats = Invoke-JsonGet "http://127.0.0.1:$Port/proxy-stats"
  $doctor = Invoke-PxpipeDoctor
  $metrics = Select-Metrics $label $capturedAt $version $stats $doctor

  Write-JsonFile (Join-Path $sampleDir "version.json") $version
  Write-JsonFile (Join-Path $sampleDir "proxy-stats.json") $stats
  Write-JsonFile (Join-Path $sampleDir "doctor.json") $doctor
  Write-JsonFile (Join-Path $sampleDir "metrics.json") $metrics

  $rows += [pscustomobject]$metrics
  Write-JsonFile (Join-Path $OutDir "metrics-series.json") $rows

  if ($i -lt ($Samples - 1)) {
    $sleepSeconds = [int]($IntervalHours * 3600)
    if ($sleepSeconds -gt 0) {
      Write-Host "[pxpipe observe] sleeping $IntervalHours hour(s)"
      Start-Sleep -Seconds $sleepSeconds
    }
  }
}

Write-Conclusions $rows (Join-Path $OutDir "conclusions.md")
Write-Host "[pxpipe observe] done: $OutDir"
