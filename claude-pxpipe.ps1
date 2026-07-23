<#
.SYNOPSIS
  Avvia pxpipe-proxy e lancia Claude Code puntato al proxy locale.
  Alla chiusura di questa finestra/processo (X, Ctrl+C, crash, kill esterno)
  l'intero albero di processi del proxy (cmd -> npx -> node) viene ucciso
  automaticamente tramite un Job Object di Windows (KILL_ON_JOB_CLOSE).

.PARAMETER ProxyHost
  Host del proxy (default 127.0.0.1)

.PARAMETER ProxyPort
  Porta del proxy (default 47821)

.PARAMETER TimeoutSeconds
  Attesa massima che il proxy sia pronto (default 60s)

.EXAMPLE
  .\claude-pxpipe.ps1
#>

[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$ProxyHost      = "127.0.0.1",
    [int]   $ProxyPort      = 47821,
    [int]   $TimeoutSeconds = 60,
    [string]$PxpipeModels   = "",   # es. "off" per disabilitare imaging, o allowlist custom

    # -DebugCapture: modalita' debug completa. Catena:
    #   claude -> tap1:47820 -> pxpipe:47821 -> tap2:47822 -> api.anthropic.com
    #  - tap1 (pxpipe-tap.js) salva OGNI request/response PRE-transform
    #    in D:\Esperimenti\pxpipe-tap\
    #  - tap2 (pxpipe-tap2.js) salva OGNI request/response POST-transform
    #    in D:\Esperimenti\pxpipe-tap2\ (pxpipe parte con ANTHROPIC_UPSTREAM=tap2)
    #  - attiva PXPIPE_DEBUG_CAPTURE_4XX=1 sul proxy (body dei 4xx in ~/.pxpipe)
    #  - lancia claude con --debug e ANTHROPIC_BASE_URL puntato a tap1
    [switch]$DebugCapture,

    # -Local: avvia il repo locale (D:\Esperimenti\pxpipe) con `pnpm run restart`
    # (kill orfani + rebuild + start) invece di npx pxpipe-proxy@latest. Utile per testare modifiche a
    # src/core/transform.ts (es. DYNAMIC_BLOCK_TAGS). Salta anche la pulizia
    # della cache npx, inutile in questa modalita'.
    [switch]$Local,

    # Tutto cio' che non matcha i parametri sopra viene passato a `claude` cosi' com'e'.
    # Esempi: claudepx --debug | claudepx --resume <id> --debug
    [Parameter(ValueFromRemainingArguments = $true, Position = 0)]
    [string[]]$ClaudeArgs
)

$ErrorActionPreference = "Stop"

# ============================================================
# === CONFIG: modifica qui i path locali ======================
# ============================================================
$PxpipeLocalRepo  = "D:\Esperimenti\pxpipe"              # repo locale (-Local)
$PxpipeTapScript  = "D:\Esperimenti\pxpipe-tap.js"        # tap PRE-transform (-DebugCapture)
$PxpipeTap2Script = "D:\Esperimenti\pxpipe-tap2.js"       # tap POST-transform (-DebugCapture)
$ClaudeExePath    = "claude"                              # eseguibile claude (nome nel PATH o path assoluto)
# ============================================================

# ============================================================
# === claude-mem: wrapper noproxy (solo Windows) ==============
# ============================================================
# Il worker di claude-mem lancia claude ereditando ANTHROPIC_BASE_URL e
# finirebbe dentro al proxy pxpipe. claude-noproxy.exe (sorgente:
# claude-noproxy.cs in questa repo) azzera ANTHROPIC_BASE_URL e rilancia
# il vero claude.exe. Check velocissimo a ogni avvio:
#  1) se l'exe manca (o il .cs e' piu' recente) -> compila al volo con csc
#  2) se CLAUDE_CODE_PATH nel settings di claude-mem non punta all'exe -> fix
# Il check viene eseguito SOLO se claude-mem risulta installato e attivo
# come plugin: si legge enabledPlugins in ~\.claude\settings.json cercando
# una chiave "claude-mem@..." = true (nessun processo claude necessario).
$memActive = $false
if ($env:OS -eq "Windows_NT") {
    try {
        $claudeSettingsPath = Join-Path $env:USERPROFILE ".claude\settings.json"
        if (Test-Path $claudeSettingsPath) {
            $enabled = (Get-Content $claudeSettingsPath -Raw | ConvertFrom-Json).enabledPlugins
            if ($enabled) {
                foreach ($p in $enabled.PSObject.Properties) {
                    if ($p.Name -like "claude-mem@*" -and $p.Value) { $memActive = $true; break }
                }
            }
        }
    } catch { $memActive = $false }
}
if ($memActive) {
    try {
        $noproxyExe = Join-Path $PxpipeLocalRepo "claude-noproxy.exe"
        $noproxyCs  = Join-Path $PxpipeLocalRepo "claude-noproxy.cs"

        if (Test-Path $noproxyCs) {
            $needBuild = (-not (Test-Path $noproxyExe)) -or
                         ((Get-Item $noproxyCs).LastWriteTimeUtc -gt (Get-Item $noproxyExe).LastWriteTimeUtc)
            if ($needBuild) {
                $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
                if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }
                if (Test-Path $csc) {
                    Write-Host "[claude-mem] compilo claude-noproxy.exe da claude-noproxy.cs..." -ForegroundColor DarkCyan
                    & $csc /nologo /optimize /target:exe "/out:$noproxyExe" $noproxyCs | Out-Null
                    if ($LASTEXITCODE -ne 0) { Write-Host "[claude-mem] compilazione fallita (exit $LASTEXITCODE)" -ForegroundColor DarkYellow }
                } else {
                    Write-Host "[claude-mem] csc.exe non trovato: impossibile compilare claude-noproxy.exe" -ForegroundColor DarkYellow
                }
            }
        }

        $memSettingsPath = Join-Path $env:USERPROFILE ".claude-mem\settings.json"
        if ((Test-Path $noproxyExe) -and (Test-Path $memSettingsPath)) {
            $memSettings = Get-Content $memSettingsPath -Raw | ConvertFrom-Json
            if ($memSettings.CLAUDE_CODE_PATH -ne $noproxyExe) {
                if ($memSettings.PSObject.Properties.Name -contains "CLAUDE_CODE_PATH") {
                    $memSettings.CLAUDE_CODE_PATH = $noproxyExe
                } else {
                    $memSettings | Add-Member -NotePropertyName "CLAUDE_CODE_PATH" -NotePropertyValue $noproxyExe
                }
                [IO.File]::WriteAllText($memSettingsPath,
                    ($memSettings | ConvertTo-Json -Depth 5),
                    (New-Object System.Text.UTF8Encoding($false)))
                Write-Host "[claude-mem] CLAUDE_CODE_PATH aggiornato -> $noproxyExe" -ForegroundColor DarkCyan
            }
        }
    } catch {
        Write-Host "[claude-mem] check noproxy fallito: $_" -ForegroundColor DarkYellow
    }
}

$proxyUrl = "http://{0}:{1}" -f $ProxyHost, $ProxyPort

# --- Job Object: garantisce la morte dell'intero process tree del proxy
#     quando questo script/finestra termina, in QUALUNQUE modo. ---
$jobSource = @"
using System;
using System.Runtime.InteropServices;

public static class KillOnCloseJob
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr a, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;

    public static IntPtr Create()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(length);
        Marshal.StructureToPtr(info, ptr, false);
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)length);
        Marshal.FreeHGlobal(ptr);
        return job;
    }
}
"@
Add-Type -TypeDefinition $jobSource -Language CSharp
$jobHandle = [KillOnCloseJob]::Create()

function Test-Port {
    param([string]$TargetHost, [int]$Port, [int]$TimeoutMs = 300)
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async  = $client.BeginConnect($TargetHost, $Port, $null, $null)
        $ok     = $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false) -and $client.Connected
        $client.Close()
        return [bool]$ok
    } catch {
        return $false
    }
}

$startedByUs = $false
$proxyProc   = $null
$tap2Proc    = $null
$Tap2Port    = 47822

if (Test-Port -TargetHost $ProxyHost -Port $ProxyPort) {
    Write-Host "[i] Proxy gia' attivo su $proxyUrl, lo riuso." -ForegroundColor Yellow
    if ($DebugCapture) {
        Write-Host "[!] DebugCapture: il proxy gia' attivo NON passa da tap2 (upstream fissato" -ForegroundColor Red
        Write-Host "    all'avvio). Per il capture POST-transform chiudi il proxy e rilancia." -ForegroundColor Red
    }
} else {
    # --- Pulizia vecchie versioni di pxpipe-proxy dalla cache npx ---
    # Solo in modalita' npx: con -Local la cache non c'entra nulla.
    if (-not $Local) {
        $npxCache = Join-Path $env:LOCALAPPDATA "npm-cache\_npx"
        if (Test-Path $npxCache) {
            Get-ChildItem $npxCache -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                $pkgJson = Join-Path $_.FullName "package.json"
                if ((Test-Path $pkgJson) -and (Select-String -Path $pkgJson -Pattern "pxpipe-proxy" -Quiet)) {
                    Write-Host "[i] Rimuovo vecchia cache npx: $($_.Name)" -ForegroundColor DarkYellow
                    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }

    # --- DebugCapture: tap2 (POST-transform) va su PRIMA del proxy, perche'
    #     pxpipe legge ANTHROPIC_UPSTREAM all'avvio e fa subito i probe. ---
    if ($DebugCapture) {
        $tap2Script = $PxpipeTap2Script
        if (-not (Test-Path $tap2Script)) {
            Write-Host "[!] $tap2Script non trovato. Copialo li' e rilancia." -ForegroundColor Red
            exit 1
        }
        Write-Host "[*] DebugCapture: avvio tap2 su porta $Tap2Port -> api.anthropic.com ..." -ForegroundColor Magenta
        $tap2Proc = Start-Process -FilePath "node" `
            -ArgumentList "`"$tap2Script`" $Tap2Port" `
            -WindowStyle Minimized -PassThru
        [KillOnCloseJob]::AssignProcessToJobObject($jobHandle, $tap2Proc.Handle) | Out-Null

        $elapsedMs = 0
        while (-not (Test-Port -TargetHost "127.0.0.1" -Port $Tap2Port)) {
            Start-Sleep -Milliseconds 250
            $elapsedMs += 250
            if ($elapsedMs -ge 10000) {
                Write-Host "[!] Tap2 non pronto dopo 10s. Interrompo." -ForegroundColor Red
                exit 1
            }
        }
        Write-Host "[OK] Tap2 pronto (PID $($tap2Proc.Id)). Log in $(Split-Path $PxpipeTap2Script)\pxpipe-tap2\" -ForegroundColor Green
    }

    # -y evita il prompt "Ok to proceed? (y)" al primo download del pacchetto,
    # che in background bloccherebbe tutto indefinitamente
    $envPrefix = ""
    if ($PxpipeModels) { $envPrefix += "set PXPIPE_MODELS=$PxpipeModels&& " }
    if ($DebugCapture) {
        $envPrefix += "set PXPIPE_DEBUG_CAPTURE_4XX=1&& "
        $envPrefix += "set ANTHROPIC_UPSTREAM=http://127.0.0.1:$Tap2Port&& "
    }

    if ($Local) {
        $localRepo = $PxpipeLocalRepo
        if (-not (Test-Path (Join-Path $localRepo "package.json"))) {
            Write-Host "[!] Repo locale non trovato: $localRepo" -ForegroundColor Red
            exit 1
        }

        # Versione dal package.json del repo locale (pnpm run restart
        # ricompila comunque, quindi niente check sulla build in dist\).
        $version = $null
        try {
            $version = (Get-Content (Join-Path $localRepo "package.json") -Raw | ConvertFrom-Json).version
        } catch {}
        if ($version) {
            Write-Host "[i] pxpipe versione: $version (locale, $localRepo)" -ForegroundColor DarkCyan
        } else {
            Write-Host "[i] pxpipe versione: sconosciuta (package.json non leggibile)" -ForegroundColor DarkYellow
        }

        # pnpm run restart: uccide eventuali proxy pxpipe orfani, ricompila
        # (pnpm run build) e avvia il proxy fresco (node bin/cli.js).
        Write-Host "[*] Avvio pxpipe LOCALE (pnpm run restart) su $proxyUrl ..." -ForegroundColor Magenta
        $cmdLine = "/c cd /d `"$localRepo`"&& ${envPrefix}pnpm run restart"
    } else {
        # Versione che npx sta per usare, prima di avviarla per davvero.
        # Gia' in cache dopo il primo download, quindi rapido.
        $verRaw = & npx -y pxpipe-proxy@latest --version 2>$null
        $version = ($verRaw | Select-String -Pattern '^\d+\.\d+\.\d+' | Select-Object -Last 1)
        if ($version) {
            Write-Host "[i] pxpipe versione: $version (npx @latest)" -ForegroundColor DarkCyan
        } else {
            Write-Host "[i] pxpipe versione: sconosciuta (output --version non riconosciuto)" -ForegroundColor DarkYellow
        }

        Write-Host "[*] Avvio pxpipe-proxy su $proxyUrl ..." -ForegroundColor Cyan
        $cmdLine = "/c ${envPrefix}npx -y pxpipe-proxy@latest"
    }
    $proxyProc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList $cmdLine `
        -WindowStyle Minimized -PassThru
    $startedByUs = $true

    # Aggancio IMMEDIATO al job: i figli generati da qui in poi (npx -> node)
    # ereditano automaticamente il job e vengono uccisi con lui.
    [KillOnCloseJob]::AssignProcessToJobObject($jobHandle, $proxyProc.Handle) | Out-Null

    $elapsedMs = 0
    $step      = 500
    while (-not (Test-Port -TargetHost $ProxyHost -Port $ProxyPort)) {
        Start-Sleep -Milliseconds $step
        $elapsedMs += $step
        if ($elapsedMs -ge ($TimeoutSeconds * 1000)) {
            Write-Host "[!] Proxy non pronto dopo $TimeoutSeconds sec. Interrompo." -ForegroundColor Red
            if (-not $proxyProc.HasExited) { & taskkill /PID $proxyProc.Id /T /F | Out-Null }
            exit 1
        }
    }
    Write-Host "[OK] Proxy pronto (PID $($proxyProc.Id))." -ForegroundColor Green
}

try {
    $claudeTarget = $proxyUrl
    $tapProc = $null

    if ($DebugCapture) {
        # --- Avvio del relay di logging (pxpipe-tap.js) ---
        $tapScript = $PxpipeTapScript
        $tapPort   = 47820
        if (-not (Test-Path $tapScript)) {
            Write-Host "[!] $tapScript non trovato. Copialo li' e rilancia." -ForegroundColor Red
            exit 1
        }
        Write-Host "[*] DebugCapture: avvio tap su porta $tapPort -> pxpipe $ProxyPort ..." -ForegroundColor Magenta
        $tapProc = Start-Process -FilePath "node" `
            -ArgumentList "`"$tapScript`" $tapPort $ProxyPort" `
            -WindowStyle Minimized -PassThru
        [KillOnCloseJob]::AssignProcessToJobObject($jobHandle, $tapProc.Handle) | Out-Null

        $elapsedMs = 0
        while (-not (Test-Port -TargetHost "127.0.0.1" -Port $tapPort)) {
            Start-Sleep -Milliseconds 250
            $elapsedMs += 250
            if ($elapsedMs -ge 10000) {
                Write-Host "[!] Tap non pronto dopo 10s. Interrompo." -ForegroundColor Red
                exit 1
            }
        }
        Write-Host "[OK] Tap pronto (PID $($tapProc.Id)). Log in $(Split-Path $PxpipeTapScript)\pxpipe-tap\" -ForegroundColor Green

        # claude parla col TAP, che inoltra a pxpipe
        $claudeTarget = "http://127.0.0.1:$tapPort"

        # claude --debug: aggiungilo agli argomenti se non gia' presente
        if ($ClaudeArgs -notcontains "--debug") {
            $ClaudeArgs = @("--debug") + @($ClaudeArgs | Where-Object { $_ })
        }
        Write-Host "[*] DebugCapture: claude partira' con --debug" -ForegroundColor Magenta
    }

    $env:ANTHROPIC_BASE_URL = $claudeTarget
    Write-Host "[>] claude -> ANTHROPIC_BASE_URL=$claudeTarget" -ForegroundColor Cyan
    & $ClaudeExePath @ClaudeArgs
}
finally {
    Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue

    if ($tapProc -and -not $tapProc.HasExited) {
        Write-Host "[x] Chiudo pxpipe-tap (PID $($tapProc.Id))." -ForegroundColor Yellow
        & taskkill /PID $tapProc.Id /T /F | Out-Null
    }
    if ($tap2Proc -and -not $tap2Proc.HasExited) {
        Write-Host "[x] Chiudo pxpipe-tap2 (PID $($tap2Proc.Id))." -ForegroundColor Yellow
        & taskkill /PID $tap2Proc.Id /T /F | Out-Null
    }
    if ($startedByUs -and -not $proxyProc.HasExited) {
        Write-Host "[x] Chiudo pxpipe-proxy (PID $($proxyProc.Id))." -ForegroundColor Yellow
        & taskkill /PID $proxyProc.Id /T /F | Out-Null
    }
    # Se anche questo blocco non fa in tempo a girare (finestra chiusa a forza),
    # ci pensa comunque il Job Object non appena il processo PowerShell termina.
}