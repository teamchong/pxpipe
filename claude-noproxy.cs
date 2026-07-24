using System;
using System.Diagnostics;
using System.IO;
using System.Text;

class Program
{
    static int Main(string[] args)
    {
        Environment.SetEnvironmentVariable("ANTHROPIC_BASE_URL", null);

        string claudeExe = ResolveClaudeExe();
        if (claudeExe == null)
        {
            Console.Error.WriteLine("claude-noproxy: claude.exe non trovato (ne' in %USERPROFILE%\\.local\\bin ne' nel PATH).");
            return 1;
        }

        var psi = new ProcessStartInfo
        {
            FileName = claudeExe,
            Arguments = BuildArguments(args),
            UseShellExecute = false
        };

        using (var p = Process.Start(psi))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    // Cerca claude.exe: 1) env CLAUDE_NOPROXY_TARGET, 2) %USERPROFILE%\.local\bin, 3) PATH
    static string ResolveClaudeExe()
    {
        string overridePath = Environment.GetEnvironmentVariable("CLAUDE_NOPROXY_TARGET");
        if (!string.IsNullOrEmpty(overridePath) && File.Exists(overridePath))
            return overridePath;

        string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string localBin = Path.Combine(userProfile, ".local", "bin", "claude.exe");
        if (File.Exists(localBin))
            return localBin;

        string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in pathEnv.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            try
            {
                string candidate = Path.Combine(dir.Trim(), "claude.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException) { /* dir con caratteri invalidi nel PATH: ignora */ }
        }
        return null;
    }

    static string BuildArguments(string[] args)
    {
        var sb = new StringBuilder();
        foreach (var arg in args)
        {
            if (sb.Length > 0) sb.Append(' ');
            AppendArg(sb, arg);
        }
        return sb.ToString();
    }

    // Algoritmo standard CommandLineToArgvW-compatible (lo stesso usato
    // internamente da .NET per ArgumentList) — gestisce stringhe vuote,
    // spazi e backslash-prima-di-virgolette correttamente.
    static void AppendArg(StringBuilder sb, string arg)
    {
        bool needsQuotes = arg.Length == 0 || arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) >= 0;
        if (!needsQuotes) { sb.Append(arg); return; }

        sb.Append('"');
        for (int i = 0; i < arg.Length; )
        {
            char c = arg[i++];
            if (c == '\\')
            {
                int n = 1;
                while (i < arg.Length && arg[i] == '\\') { n++; i++; }
                if (i == arg.Length) sb.Append('\\', n * 2);
                else if (arg[i] == '"') { sb.Append('\\', n * 2 + 1).Append('"'); i++; }
                else sb.Append('\\', n);
            }
            else if (c == '"') sb.Append('\\').Append('"');
            else sb.Append(c);
        }
        sb.Append('"');
    }
}