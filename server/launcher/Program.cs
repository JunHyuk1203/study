using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Net.Security;
using System.Net.NetworkInformation;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace StudyServer;

internal static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        string? testRoot = args.Length == 2 && args[0] == "--self-test" ? Path.GetFullPath(args[1]) : null;
        using var mutex = new Mutex(true, testRoot == null ? "Local\\StudyServer-20261024" : "Local\\StudyServer-Diagnostics", out bool first);
        if (!first)
        {
            if (testRoot != null) { Directory.CreateDirectory(testRoot); File.WriteAllText(Path.Combine(testRoot, "result.json"), "{\"ok\":false,\"error\":\"Another diagnostic is running\"}"); Environment.ExitCode = 1; }
            else MessageBox.Show("이미 실행 중인 STUDY 서버 창을 확인해 주세요.", "STUDY");
            return;
        }
        Application.Run(new ServerForm(testRoot));
    }
}

internal sealed class Settings
{
    public string ServiceAccountJson { get; set; } = "";
    public string NeisKey { get; set; } = "";
    public string AiKey { get; set; } = "";
    public string FaceKmsKey { get; set; } = "";
    public string TunnelToken { get; set; } = "";
    public string PublicUrl { get; set; } = "https://api.study.junhyuk.site";
    public string NetworkMode { get; set; } = "direct";
    public string AllowedOrigins { get; set; } = "https://study.junhyuk.site\nhttps://word.junhyuk.site\nhttps://junhyuk1203.github.io\nhttp://127.0.0.1:5173\nhttp://localhost:5173";
    public string OwnerPassword { get; set; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    public string AppPassword { get; set; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    public string DatabaseName { get; set; } = "study";
}

internal sealed class ServerForm : Form
{
    readonly string root;
    readonly bool diagnostics;
    readonly Label status = new() { Text = "서버 준비 중", AutoSize = true, Font = new Font("맑은 고딕", 15, FontStyle.Bold) };
    readonly TextBox log = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill };
    readonly Label guidance = new() { Dock = DockStyle.Fill, Text = "저장된 연결 설정으로 자동 시작합니다.\n\n주소·포트·Firebase 프로젝트는 미리 설정되어 있습니다.\nDNS·공유기·방화벽의 최초 연결 설정을 마치면 인터넷에서 접속할 수 있습니다.\n\n창을 닫으면 서버가 종료됩니다.\n계정 로그인은 계속 Firebase를 사용합니다.", Padding = new Padding(8), AutoSize = false };
    readonly Button startButton = new() { Text = "서버 시작", AutoSize = true };
    readonly Button stopButton = new() { Text = "서버 종료", AutoSize = true, Enabled = false };
    readonly Button backupButton = new() { Text = "백업", AutoSize = true, Enabled = false };
    readonly Button restoreButton = new() { Text = "백업 복원", AutoSize = true };
    readonly Button settingsButton = new() { Text = "설정", AutoSize = true };
    readonly HttpClient client = new() { Timeout = TimeSpan.FromSeconds(3) };
    readonly System.Windows.Forms.Timer connectionTimer = new() { Interval = 10000 };
    readonly List<Process> children = [];
    Settings settings = new();
    Process? api;
    Process? connector;
    Process? postgres;
    string runtime = "";
    bool databaseStarted, busy, closing, exitReady;
    bool checkingConnection;
    string? activeInstance;
    int Port => diagnostics ? 18082 : 18081;
    int PgPort => diagnostics ? 15434 : 15432;
    string DataPath => Path.Combine(root, "data", "postgres");
    string ConfigPath => Path.Combine(root, "config", "settings.protected");
    string Pg(string executable) => Path.Combine(runtime, "postgres", "bin", executable + ".exe");
    string LocalUrl => $"http://127.0.0.1:{Port}";

    public ServerForm(string? testRoot = null)
    {
        root = testRoot ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StudyServer");
        diagnostics = testRoot != null;
        Text = "STUDY Server"; Width = 840; Height = 640; MinimumSize = new Size(760, 540);
        Font = new Font("맑은 고딕", 10); StartPosition = FormStartPosition.CenterScreen;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 5, ColumnCount = 1, Padding = new Padding(18) };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 70));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 65));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.Controls.Add(status, 0, 0);
        layout.Controls.Add(new Label { Text = "웹: GitHub Pages 유지  ·  로그인: Firebase Auth 유지\n이 창을 닫으면 서버가 종료됩니다.", Dock = DockStyle.Fill, AutoSize = false }, 0, 1);
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill };
        foreach (var button in new[] { startButton, stopButton, settingsButton, backupButton, restoreButton }) buttons.Controls.Add(button);
        var website = new Button { Text = "사이트 열기", AutoSize = true };
        website.Click += (_, _) => Process.Start(new ProcessStartInfo("https://study.junhyuk.site") { UseShellExecute = true });
        buttons.Controls.Add(website);
        var details = new CheckBox { Text = "상세 로그 보기", AutoSize = true };
        var content = new Panel { Dock = DockStyle.Fill }; content.Controls.Add(log); content.Controls.Add(guidance); log.Visible = false;
        details.CheckedChanged += (_, _) => { log.Visible = details.Checked; guidance.Visible = !details.Checked; };
        layout.Controls.Add(buttons, 0, 2); layout.Controls.Add(details, 0, 3); layout.Controls.Add(content, 0, 4); Controls.Add(layout);
        startButton.Click += async (_, _) => await Guard(StartAsync);
        stopButton.Click += async (_, _) => await Guard(StopAsync);
        backupButton.Click += async (_, _) => await Guard(BackupAsync);
        restoreButton.Click += async (_, _) => await Guard(RestoreAsync);
        settingsButton.Click += (_, _) => EditSettings();
        connectionTimer.Tick += async (_, _) => await RefreshPublicStatus();
        FormClosing += async (_, e) =>
        {
            if (exitReady) return;
            e.Cancel = true;
            if (busy || closing) return;
            closing = true;
            try { await StopAsync(); } catch { }
            exitReady = true; Close();
        };
        Shown += async (_, _) =>
        {
            if (diagnostics)
            {
                Hide();
                try { await SelfTest(); File.WriteAllText(Path.Combine(root, "result.json"), "{\"ok\":true,\"checks\":[\"payload-extraction\",\"postgres-start\",\"api-health\",\"unauthenticated-rejected\",\"pg-dump\",\"pg-restore\",\"backup-encryption\",\"graceful-stop\"]}"); }
                catch (Exception error) { Directory.CreateDirectory(root); File.WriteAllText(Path.Combine(root, "result.json"), JsonSerializer.Serialize(new { ok = false, error = error.Message, log = log.Text })); Environment.ExitCode = 1; }
                finally { try { await StopAsync(); } catch { Environment.ExitCode = 1; } exitReady = true; Close(); }
                return;
            }
            await Guard(async () =>
            {
                Directory.CreateDirectory(Path.Combine(root, "config"));
                Directory.CreateDirectory(Path.Combine(root, "logs"));
                if (File.Exists(ConfigPath)) settings = JsonSerializer.Deserialize<Settings>(Unprotect(File.ReadAllBytes(ConfigPath))) ?? new();
                if (ApplyEmbeddedSettings(settings)) Save();
                // Upgrade existing installations as well as the defaults: Pages redirects SP word here.
                if (!settings.AllowedOrigins.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Contains("https://word.junhyuk.site", StringComparer.OrdinalIgnoreCase))
                {
                    settings.AllowedOrigins = settings.AllowedOrigins.TrimEnd() + "\nhttps://word.junhyuk.site";
                    Save();
                }
                await ExtractAsync();
                if (string.IsNullOrWhiteSpace(settings.ServiceAccountJson) && !EditSettings()) { status.Text = "초기 설정을 입력해 주세요"; return; }
                await ShowNetworkGuidance();
                await StartAsync();
            });
        };
    }

    async Task Guard(Func<Task> action)
    {
        if (busy) return;
        busy = true; RefreshButtons();
        try { await action(); }
        catch (Exception error) { status.Text = "작업을 완료하지 못했습니다"; Append(error.Message); MessageBox.Show(error.Message, "STUDY", MessageBoxButtons.OK, MessageBoxIcon.Information); }
        finally { busy = false; RefreshButtons(); }
    }
    void RefreshButtons()
    {
        bool running = api is { HasExited: false };
        startButton.Enabled = !busy && !running; stopButton.Enabled = !busy && (running || databaseStarted);
        settingsButton.Enabled = !busy && !running && !databaseStarted;
        backupButton.Enabled = !busy && databaseStarted;
        restoreButton.Enabled = !busy && !running;
    }
    void Append(string text)
    {
        if (IsDisposed || Disposing) return;
        if (InvokeRequired) { try { BeginInvoke(new Action(() => Append(text))); } catch (InvalidOperationException) { } return; }
        // Never display tokens or private key material from child diagnostics.
        if (text.Contains("PRIVATE KEY") || text.Contains("token=", StringComparison.OrdinalIgnoreCase) || text.Contains("token:", StringComparison.OrdinalIgnoreCase)) return;
        if (log.TextLength > 48000) log.Text = log.Text[^24000..];
        log.AppendText($"[{DateTime.Now:HH:mm:ss}] {text}\r\n");
    }
    static byte[] Protect(byte[] value) => ProtectedData.Protect(value, null, DataProtectionScope.CurrentUser);
    static byte[] Unprotect(byte[] value) => ProtectedData.Unprotect(value, null, DataProtectionScope.CurrentUser);
    void Save() => File.WriteAllBytes(ConfigPath, Protect(JsonSerializer.SerializeToUtf8Bytes(settings)));

    static bool ApplyEmbeddedSettings(Settings target)
    {
        using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("study-private-settings.json");
        if (resource == null) return false;
        var embedded = JsonSerializer.Deserialize<Settings>(resource) ?? throw new Exception("내장 서버 설정을 읽지 못했습니다.");
        if (string.IsNullOrWhiteSpace(embedded.ServiceAccountJson) || string.IsNullOrWhiteSpace(embedded.NeisKey) || string.IsNullOrWhiteSpace(embedded.AiKey)) throw new Exception("내장 서버 연결 설정이 불완전합니다.");
        if (string.IsNullOrWhiteSpace(target.ServiceAccountJson)) target.ServiceAccountJson = embedded.ServiceAccountJson;
        if (string.IsNullOrWhiteSpace(target.NeisKey)) target.NeisKey = embedded.NeisKey;
        if (string.IsNullOrWhiteSpace(target.AiKey)) target.AiKey = embedded.AiKey;
        if (string.IsNullOrWhiteSpace(target.FaceKmsKey)) target.FaceKmsKey = embedded.FaceKmsKey;
        // Database passwords remain unique to this PC; existing settings are retained.
        return true;
    }

    // Only our named rule is maintained. The API and database remain loopback-only.
    static string FirewallCommand(string caddy, bool apply) => $$"""
        $ErrorActionPreference='Stop'
        $program='{{caddy.Replace("'", "''")}}'
        $ruleName='StudyServer-Caddy-HTTPS'
        function Test-StudyRule {
            $rule=Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
            if(-not $rule -or $rule.Enabled -ne 'True' -or $rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow' -or $rule.Profile -ne 'Any'){return $false}
            $app=$rule|Get-NetFirewallApplicationFilter
            $port=$rule|Get-NetFirewallPortFilter
            return ($app.Program -eq $program -and $port.Protocol -in @('TCP','6') -and ((@($port.LocalPort)|Sort-Object) -join ',') -eq '443')
        }
        if(Test-StudyRule){exit 0}
        if({{(apply ? "$false" : "$true")}}){exit 1}
        if(-not (Test-Path -LiteralPath $program -PathType Leaf)){throw 'Caddy executable missing'}
        $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
        if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator permission required'}
        Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue|Remove-NetFirewallRule
        New-NetFirewallRule -Name $ruleName -DisplayName 'STUDY Server HTTPS' -Description 'STUDY Caddy only: inbound TCP 443' -Direction Inbound -Action Allow -Enabled True -Protocol TCP -LocalPort 443 -Program $program -Profile Any|Out-Null
        if(-not (Test-StudyRule)){throw 'Firewall rule verification failed'}
        """;

    async Task EnsureFirewall()
    {
        string caddy = Path.Combine(runtime, "caddy.exe");
        string Encoded(bool apply) => Convert.ToBase64String(Encoding.Unicode.GetBytes(FirewallCommand(caddy, apply)));
        using (var probe = Launch("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Encoded(false)], track: false))
        {
            await probe.WaitForExitAsync(); if (probe.ExitCode == 0) return;
        }
        status.Text = "최초 Windows 방화벽 허용 확인";
        try
        {
            using var process = Process.Start(new ProcessStartInfo("powershell.exe") {
                UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden,
                Arguments = "-NoProfile -NonInteractive -EncodedCommand " + Encoded(true)
            }) ?? throw new Exception("방화벽 설정을 시작하지 못했습니다.");
            await process.WaitForExitAsync();
            if (process.ExitCode != 0) throw new Exception("방화벽 자동 허용에 실패했습니다. Windows 방화벽 설정을 확인해 주세요.");
        }
        catch (System.ComponentModel.Win32Exception)
        {
            throw new Exception("방화벽 허용이 취소되었습니다. 서버 시작을 다시 누르고 Windows 권한 확인에서 예를 선택해 주세요.");
        }
        Append("Caddy의 TCP 80·443 방화벽 허용 완료");
    }

    async Task ShowNetworkGuidance()
    {
        string addresses = string.Join("\n", NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up && n.GetIPProperties().GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork))
            .SelectMany(n => n.GetIPProperties().UnicastAddresses.Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork).Select(a => $"{n.Name}: {a.Address}")));
        string wan = "확인 실패 · 공유기 인터넷/WAN 주소 확인";
        try { string value = (await client.GetStringAsync("https://api.ipify.org")).Trim(); if (IPAddress.TryParse(value, out var ip) && ip.AddressFamily == AddressFamily.InterNetwork) wan = value; } catch { }
        guidance.Text = $"공개 API: {settings.PublicUrl}\n공인 IPv4: {wan}\n내부 IPv4:\n{addresses}\n\n최초 한 번: DNS A 레코드 → 공인 IPv4\n공유기 TCP 443 → 사용할 내부 IPv4의 443\n공유기에서 해당 내부 IP를 예약하세요.\n최초 Windows 방화벽 권한 확인에서 예를 선택하세요.\n\n80 포트는 사용하지 않습니다. 인증서도 443으로 발급합니다.\n이 창을 닫으면 서버가 종료됩니다.";
    }

    bool EditSettings()
    {
        if (api is { HasExited: false } || databaseStarted) return false;
        using var form = new Form { Text = "STUDY 서버 설정", Width = 650, Height = 630, StartPosition = FormStartPosition.CenterParent, Font = Font };
        var panel = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(16), AutoScroll = true };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150)); panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        int row = 0;
        void Add(string label, Control control) { panel.RowStyles.Add(new RowStyle(SizeType.AutoSize)); panel.Controls.Add(new Label { Text = label, AutoSize = true, Margin = new Padding(3, 10, 3, 3) }, 0, row); control.Dock = DockStyle.Top; panel.Controls.Add(control, 1, row++); }
        string serviceJson = settings.ServiceAccountJson;
        var browse = new Button { Text = serviceJson.Length > 0 ? "Firebase 연결 파일 등록됨 · 변경" : "Firebase 서비스 계정 JSON 선택", AutoSize = true };
        browse.Click += (_, _) => { using var picker = new OpenFileDialog { Filter = "Firebase JSON|*.json" }; if (picker.ShowDialog(form) == DialogResult.OK) { try { string value = File.ReadAllText(picker.FileName); using var doc = JsonDocument.Parse(value); if (doc.RootElement.GetProperty("project_id").GetString() != "study-junhyuk1203-20261021") throw new Exception("STUDY Firebase 프로젝트의 파일을 선택해 주세요."); serviceJson = value; browse.Text = "Firebase 연결 파일 선택됨"; } catch (Exception error) { MessageBox.Show(form, error.Message); } } };
        Add("Firebase 연결", browse);
        var neis = new TextBox { Text = settings.NeisKey, UseSystemPasswordChar = true }; Add("NEIS API 키", neis);
        var ai = new TextBox { Text = settings.AiKey, UseSystemPasswordChar = true }; Add("Google AI API 키", ai);
        var faceKms = new TextBox { Text = settings.FaceKmsKey }; Add("얼굴 Cloud KMS 키 경로", faceKms);
        var mode = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList }; mode.Items.AddRange(["로컬 확인", "Cloudflare Tunnel", "직접 HTTPS"]); mode.SelectedIndex = settings.NetworkMode == "tunnel" ? 1 : settings.NetworkMode == "direct" ? 2 : 0; Add("외부 연결 방식", mode);
        var url = new TextBox { Text = settings.PublicUrl }; Add("공개 API 주소", url);
        var token = new TextBox { Text = settings.TunnelToken, UseSystemPasswordChar = true }; Add("Tunnel 토큰", token);
        var origins = new TextBox { Text = settings.AllowedOrigins.Replace("\n", Environment.NewLine), Multiline = true, Height = 105, ScrollBars = ScrollBars.Vertical }; Add("허용할 웹 주소", origins);
        Add("", new Label { Text = "웹은 GitHub Pages를 유지합니다.\n공개 API 주소는 웹의 backend-config.js와 같아야 합니다.\n직접 HTTPS는 공유기 80·443 전달과 방화벽 설정이 필요합니다.", AutoSize = true });
        var save = new Button { Text = "설정 저장", AutoSize = true };
        save.Click += (_, _) =>
        {
            try
            {
                if (serviceJson.Length == 0) throw new Exception("Firebase 서비스 계정 JSON을 선택해 주세요.");
                using (var credential = JsonDocument.Parse(serviceJson)) if (credential.RootElement.GetProperty("type").GetString() != "service_account" || !credential.RootElement.TryGetProperty("private_key", out _) || !credential.RootElement.TryGetProperty("client_email", out _)) throw new Exception("Firebase 웹 설정이 아닌 서비스 계정 JSON을 선택해 주세요.");
                if (!Uri.TryCreate(url.Text.Trim(), UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.AbsolutePath != "/" || uri.UserInfo.Length > 0 || uri.Port != 443 || uri.Query.Length > 0 || uri.Fragment.Length > 0 || Uri.CheckHostName(uri.Host) != UriHostNameType.Dns) throw new Exception("공개 API 주소를 https://api.example.com 형태로 입력해 주세요.");
                var allowed = origins.Lines.Select(s => s.Trim()).Where(s => s.Length > 0).Distinct().ToArray();
                if (allowed.Length == 0 || allowed.Any(s => !Uri.TryCreate(s, UriKind.Absolute, out var u) || u.GetLeftPart(UriPartial.Authority) != s || (u.Scheme != "https" && !(u.Scheme == "http" && u.IsLoopback)))) throw new Exception("허용할 웹 주소를 한 줄에 하나씩 입력해 주세요. 경로는 제외합니다.");
                if (mode.SelectedIndex == 1 && string.IsNullOrWhiteSpace(token.Text)) throw new Exception("Tunnel 토큰을 입력해 주세요.");
                if (faceKms.Text.Trim().Length > 0 && !Regex.IsMatch(faceKms.Text.Trim(), "^projects/[^/]+/locations/[^/]+/keyRings/[^/]+/cryptoKeys/[^/]+$")) throw new Exception("Cloud KMS의 전체 cryptoKeys 경로를 입력해 주세요.");
                settings.ServiceAccountJson = serviceJson; settings.NeisKey = neis.Text.Trim(); settings.AiKey = ai.Text.Trim(); settings.FaceKmsKey = faceKms.Text.Trim(); settings.PublicUrl = uri.GetLeftPart(UriPartial.Authority); settings.TunnelToken = token.Text.Trim(); settings.NetworkMode = new[] { "local", "tunnel", "direct" }[mode.SelectedIndex]; settings.AllowedOrigins = string.Join('\n', allowed); Save(); form.DialogResult = DialogResult.OK; form.Close();
            }
            catch (Exception error) { MessageBox.Show(form, error.Message); }
        };
        Add("", save); form.Controls.Add(panel); return form.ShowDialog(this) == DialogResult.OK;
    }

    async Task ExtractAsync()
    {
        status.Text = "실행 파일 준비 중";
        await Task.Run(() =>
        {
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("study-payload.zip") ?? throw new Exception("실행 구성 파일이 없는 개발 빌드입니다. prepare-runtime.ps1 후 다시 빌드해 주세요.");
            string version = Convert.ToHexString(SHA256.HashData(stream))[..16].ToLowerInvariant(); stream.Position = 0;
            runtime = Path.Combine(root, "runtime", version);
            if (File.Exists(Path.Combine(runtime, ".ready"))) return;
            Directory.CreateDirectory(runtime);
            using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
            string prefix = Path.GetFullPath(runtime) + Path.DirectorySeparatorChar;
            foreach (var entry in archive.Entries)
            {
                string destination = Path.GetFullPath(Path.Combine(runtime, entry.FullName));
                if (!destination.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new Exception("실행 구성 파일 경로가 올바르지 않습니다.");
                if (entry.Name.Length == 0) { Directory.CreateDirectory(destination); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!); entry.ExtractToFile(destination, true);
            }
            File.WriteAllText(Path.Combine(runtime, ".ready"), version);
        });
        Append("실행 구성 준비 완료");
    }
    static void CheckPort(int port)
    {
        var listener = new TcpListener(IPAddress.Loopback, port);
        try { listener.Start(); } catch (SocketException) { throw new Exception($"{port} 포트를 다른 프로그램이 사용하고 있습니다. 기존 서버 실행 여부를 확인해 주세요."); } finally { listener.Stop(); }
    }
    Process Launch(string file, IEnumerable<string> args, Dictionary<string, string>? env = null, bool track = true)
    {
        var info = new ProcessStartInfo(file) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = runtime, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        foreach (string arg in args) info.ArgumentList.Add(arg);
        if (env != null) foreach (var pair in env) info.Environment[pair.Key] = pair.Value;
        var process = new Process { StartInfo = info, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => { if (!string.IsNullOrEmpty(e.Data)) Append(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (!string.IsNullOrEmpty(e.Data)) Append(e.Data); };
        process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine();
        if (track) children.Add(process);
        return process;
    }
    async Task Run(string file, IEnumerable<string> args, Dictionary<string, string>? env = null, string? input = null)
    {
        using var process = Launch(file, args, env, false);
        if (input != null) await process.StandardInput.WriteLineAsync(input);
        process.StandardInput.Close();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(5));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch { if (!process.HasExited) process.Kill(true); throw new Exception("내부 작업 대기 시간이 초과되었습니다."); }
        if (process.ExitCode != 0) throw new Exception($"{Path.GetFileName(file)} 작업에 실패했습니다. 위 진단 내용을 확인해 주세요.");
    }
    Dictionary<string, string> PgEnv(bool owner = false) => new() { ["PGPASSWORD"] = owner ? settings.OwnerPassword : settings.AppPassword, ["PGCLIENTENCODING"] = "UTF8" };
    async Task StartDatabase()
    {
        if (databaseStarted) return;
        if (!Regex.IsMatch(settings.DatabaseName, "^[a-z][a-z0-9_]{0,62}$") || !Regex.IsMatch(settings.OwnerPassword, "^[a-f0-9]{64}$") || !Regex.IsMatch(settings.AppPassword, "^[a-f0-9]{64}$")) throw new Exception("DB 설정 형식이 올바르지 않습니다.");
        CheckPort(PgPort);
        if (!File.Exists(Path.Combine(DataPath, "PG_VERSION")))
        {
            if (Directory.Exists(DataPath) && Directory.EnumerateFileSystemEntries(DataPath).Any()) throw new Exception("기존 DB 폴더를 초기화하지 않았습니다. 데이터 상태를 먼저 확인해 주세요.");
            Directory.CreateDirectory(DataPath); Save();
            string passwordFile = Path.Combine(root, "config", "init-password.tmp");
            try { File.WriteAllText(passwordFile, settings.OwnerPassword, new UTF8Encoding(false)); await Run(Pg("initdb"), ["-D", DataPath, "-U", "study_owner", "--pwfile=" + passwordFile, "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C"]); }
            finally { if (File.Exists(passwordFile)) File.Delete(passwordFile); }
        }
        postgres = Launch(Pg("postgres"), ["-D", DataPath, "-h", "127.0.0.1", "-p", PgPort.ToString()]); databaseStarted = true;
        bool databaseReady = false;
        for (int attempt = 0; attempt < 60; attempt++)
        {
            if (postgres.HasExited) throw new Exception("DB가 시작되지 않았습니다. 진단 내용을 확인해 주세요.");
            try { await Run(Pg("pg_isready"), ["-h", "127.0.0.1", "-p", PgPort.ToString(), "-U", "study_owner"]); databaseReady = true; break; } catch { }
            await Task.Delay(250);
        }
        if (!databaseReady) throw new Exception("DB 연결을 확인하지 못했습니다.");
        await Run(Pg("psql"), ["-h", "127.0.0.1", "-p", PgPort.ToString(), "-U", "study_owner", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], PgEnv(true), $"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='study_app') THEN CREATE ROLE study_app LOGIN PASSWORD '{settings.AppPassword}'; END IF; END $$;");
        await Run(Pg("psql"), ["-h", "127.0.0.1", "-p", PgPort.ToString(), "-U", "study_owner", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], PgEnv(true), "SELECT 'CREATE DATABASE study OWNER study_app' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='study')\n\\gexec\n");
    }

    static string CaddyConfiguration(string domain, int apiPort, int httpsPort = 443, int httpPort = 80, string? certificate = null, string? key = null)
    {
        string tls = certificate == null ? "tls {\n  issuer acme {\n   disable_http_challenge\n  }\n }" : $"tls \"{certificate.Replace('\\', '/')}\" \"{key!.Replace('\\', '/')}\"";
        return $$"""
            {
             admin off
             auto_https disable_redirects
             http_port {{httpPort}}
             https_port {{httpsPort}}
            }
            https://{{domain}}:{{httpsPort}} {
             {{tls}}
             reverse_proxy 127.0.0.1:{{apiPort}}
            }
            """;
    }

    async Task<bool> PublicInstanceMatches(string instance)
    {
        try
        {
            using var response = await client.GetAsync(settings.PublicUrl + "/health");
            if (!response.IsSuccessStatusCode) return false;
            using var health = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            return health.RootElement.GetProperty("instanceId").GetString() == instance;
        }
        catch { return false; }
    }

    async Task RefreshPublicStatus()
    {
        if (busy || closing || checkingConnection || activeInstance == null || api is not { HasExited: false }) return;
        checkingConnection = true;
        string instance = activeInstance;
        try
        {
            if (connector is { HasExited: true })
            {
                status.Text = "HTTPS 연결 프로그램 종료 · 상세 로그를 확인해 주세요";
                connectionTimer.Stop(); return;
            }
            bool connected = await PublicInstanceMatches(instance);
            if (activeInstance == instance && api is { HasExited: false }) status.Text = connected ? "운영 중 · " + settings.PublicUrl : "로컬 실행 중 · 외부 연결 확인 필요";
        }
        finally { checkingConnection = false; }
    }

    async Task StartAsync()
    {
        if (api is { HasExited: false }) return;
        if (runtime.Length == 0) await ExtractAsync();
        if (settings.ServiceAccountJson.Length == 0) { if (!EditSettings()) return; }
        status.Text = "서버 시작 중";
        try
        {
            CheckPort(Port); await StartDatabase();
            string credential = Path.Combine(root, "config", "firebase-service-account.json");
            File.WriteAllText(credential, settings.ServiceAccountJson, new UTF8Encoding(false));
            var env = new Dictionary<string, string> {
                ["STUDY_BACKEND"] = "selfhost", ["GCLOUD_PROJECT"] = "study-junhyuk1203-20261021", ["GOOGLE_APPLICATION_CREDENTIALS"] = credential,
                ["DATABASE_URL"] = $"postgresql://study_app:{settings.AppPassword}@127.0.0.1:{PgPort}/{settings.DatabaseName}", ["STUDY_PORT"] = Port.ToString(),
                ["NEIS_API_KEY"] = settings.NeisKey, ["GOOGLE_AI_API_KEY"] = settings.AiKey, ["STUDY_ALLOWED_ORIGINS"] = JsonSerializer.Serialize(settings.AllowedOrigins.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)),
                ["FACE_KMS_KEY"] = settings.FaceKmsKey
            };
            api = Launch(Path.Combine(runtime, "node", "node.exe"), [Path.Combine(runtime, "functions", "selfhost-entry.js")], env);
            bool ready = false; string? localInstance = null;
            for (int attempt = 0; attempt < 60; attempt++)
            {
                if (api.HasExited) throw new Exception("API 서버가 종료되었습니다. 설정과 진단 내용을 확인해 주세요.");
                try { using var response = await client.GetAsync(LocalUrl + "/health"); if (response.IsSuccessStatusCode) { using var health = JsonDocument.Parse(await response.Content.ReadAsStringAsync()); localInstance = health.RootElement.GetProperty("instanceId").GetString(); ready = true; break; } } catch { }
                await Task.Delay(500);
            }
            if (!ready) throw new Exception("API 서버 시작을 확인하지 못했습니다.");
            activeInstance = localInstance;
            if (settings.NetworkMode == "tunnel")
            {
                string tokenFile = Path.Combine(root, "config", "tunnel-token.txt"); File.WriteAllText(tokenFile, settings.TunnelToken, new UTF8Encoding(false));
                connector = Launch(Path.Combine(runtime, "cloudflared.exe"), ["--no-autoupdate", "tunnel", "run", "--token-file", tokenFile]);
            }
            else if (settings.NetworkMode == "direct")
            {
                CheckPort(443);
                await EnsureFirewall();
                string domain = new Uri(settings.PublicUrl).Host;
                if (!Regex.IsMatch(domain, "^[a-zA-Z0-9.-]+$")) throw new Exception("API 도메인이 올바르지 않습니다.");
                string caddyfile = Path.Combine(root, "config", "Caddyfile"); File.WriteAllText(caddyfile, CaddyConfiguration(domain, Port));
                connector = Launch(Path.Combine(runtime, "caddy.exe"), ["run", "--config", caddyfile, "--adapter", "caddyfile"], new() { ["XDG_DATA_HOME"] = Path.Combine(root, "data", "caddy") });
            }
            status.Text = settings.NetworkMode == "local" ? "로컬 실행 중 · 외부 연결 미설정" : "서버 실행 중 · 외부 접속 확인 중";
            Append("로컬 API: " + LocalUrl + " · 웹 호스팅은 GitHub Pages 유지");
            if (settings.NetworkMode != "local")
            {
                bool connected = false;
                for (int attempt = 0; attempt < 8; attempt++)
                {
                    if (connector is { HasExited: true }) throw new Exception("HTTPS 연결 프로그램이 종료되었습니다. 상세 로그에서 오류를 확인해 주세요. 80 포트는 사용하지 않으며 443 포트가 필요합니다.");
                    if (await PublicInstanceMatches(localInstance!)) { connected = true; break; }
                    await Task.Delay(1000);
                }
                status.Text = connected ? "운영 중 · " + settings.PublicUrl : "로컬 실행 중 · 외부 연결 확인 필요";
                connectionTimer.Start();
            }
        }
        catch { await StopAsync(); throw; }
    }
    async Task StopAsync()
    {
        connectionTimer.Stop(); activeInstance = null;
        if (connector is { HasExited: false }) { connector.Kill(true); await connector.WaitForExitAsync(); }
        connector = null;
        if (api is { HasExited: false })
        {
            await api.StandardInput.WriteLineAsync("shutdown");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(35));
            try { await api.WaitForExitAsync(timeout.Token); } catch { if (!api.HasExited) api.Kill(true); }
        }
        api = null;
        if (databaseStarted)
        {
            if (postgres is { HasExited: false }) await Run(Pg("pg_ctl"), ["-D", DataPath, "-m", "fast", "-w", "stop"]);
            databaseStarted = false; postgres = null;
        }
        foreach (var process in children) process.Dispose(); children.Clear();
        foreach (string name in new[] { "firebase-service-account.json", "tunnel-token.txt" }) { string path = Path.Combine(root, "config", name); if (File.Exists(path)) File.Delete(path); }
        status.Text = "서버 중지";
    }

    string? BackupPassword(bool confirm)
    {
        using var form = new Form { Text = confirm ? "백업 암호 설정" : "백업 암호 입력", Width = 440, Height = confirm ? 210 : 170, StartPosition = FormStartPosition.CenterParent, Font = Font };
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, Padding = new Padding(12) };
        panel.Controls.Add(new Label { Text = "백업 암호 (8자 이상)", AutoSize = true }); var first = new TextBox { Width = 380, UseSystemPasswordChar = true }; panel.Controls.Add(first);
        var second = new TextBox { Width = 380, UseSystemPasswordChar = true, PlaceholderText = "암호 다시 입력" }; if (confirm) panel.Controls.Add(second);
        var button = new Button { Text = "확인", AutoSize = true }; string? value = null;
        button.Click += (_, _) => { if (first.Text.Length < 8 || confirm && first.Text != second.Text) { MessageBox.Show(form, "암호 길이와 확인 입력을 확인해 주세요."); return; } value = first.Text; form.DialogResult = DialogResult.OK; form.Close(); };
        panel.Controls.Add(button); form.Controls.Add(panel); return form.ShowDialog(this) == DialogResult.OK ? value : null;
    }
    static byte[] CryptBackup(byte[] input, string password, bool decrypt)
    {
        byte[] header = Encoding.ASCII.GetBytes("STUDYBK1");
        if (decrypt && (input.Length < 52 || !input.AsSpan(0, 8).SequenceEqual(header))) throw new Exception("지원하지 않는 백업 파일입니다.");
        byte[] salt = decrypt ? input[8..24] : RandomNumberGenerator.GetBytes(16), nonce = decrypt ? input[24..36] : RandomNumberGenerator.GetBytes(12);
        byte[] key = Rfc2898DeriveBytes.Pbkdf2(password, salt, 600000, HashAlgorithmName.SHA256, 32);
        try
        {
            using var aes = new AesGcm(key, 16);
            if (decrypt) { byte[] plain = new byte[input.Length - 52]; aes.Decrypt(nonce, input.AsSpan(52), input.AsSpan(36, 16), plain, header); return plain; }
            byte[] cipher = new byte[input.Length], tag = new byte[16]; aes.Encrypt(nonce, input, cipher, tag, header); return [.. header, .. salt, .. nonce, .. tag, .. cipher];
        }
        finally { CryptographicOperations.ZeroMemory(key); }
    }
    void DeleteBackupTemporary(string path)
    {
        string allowed = Path.GetFullPath(Path.Combine(root, "backups")) + Path.DirectorySeparatorChar;
        string resolved = Path.GetFullPath(path);
        if (!resolved.StartsWith(allowed, StringComparison.OrdinalIgnoreCase)) throw new Exception("백업 임시 경로가 올바르지 않습니다.");
        if (Directory.Exists(resolved)) Directory.Delete(resolved, true);
    }
    async Task BackupAsync()
    {
        using var picker = new SaveFileDialog { Filter = "암호화 STUDY 백업|*.studybackup", FileName = "study-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".studybackup" };
        if (picker.ShowDialog(this) != DialogResult.OK) return;
        string? password = BackupPassword(true); if (password == null) return;
        string temp = Path.Combine(root, "backups", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(temp);
        try
        {
            await Run(Pg("pg_dump"), ["-h", "127.0.0.1", "-p", PgPort.ToString(), "-U", "study_app", "-d", settings.DatabaseName, "-F", "c", "--no-owner", "-f", Path.Combine(temp, "database.dump")], PgEnv());
            File.WriteAllText(Path.Combine(temp, "settings.json"), JsonSerializer.Serialize(settings));
            using var memory = new MemoryStream();
            using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, true)) foreach (string file in Directory.EnumerateFiles(temp)) zip.CreateEntryFromFile(file, Path.GetFileName(file));
            byte[] encrypted = await Task.Run(() => CryptBackup(memory.ToArray(), password, false));
            await File.WriteAllBytesAsync(picker.FileName + ".partial", encrypted); File.Move(picker.FileName + ".partial", picker.FileName, true);
            Append("암호화 백업 완료: " + picker.FileName);
        }
        finally { DeleteBackupTemporary(temp); }
    }
    async Task RestoreAsync()
    {
        using var picker = new OpenFileDialog { Filter = "암호화 STUDY 백업|*.studybackup" }; if (picker.ShowDialog(this) != DialogResult.OK) return;
        string? password = BackupPassword(false); if (password == null) return;
        byte[] clear;
        try { byte[] encrypted = await File.ReadAllBytesAsync(picker.FileName); clear = await Task.Run(() => CryptBackup(encrypted, password, true)); }
        catch (CryptographicException) { throw new Exception("백업 암호가 다르거나 파일이 손상되었습니다."); }
        string temp = Path.Combine(root, "backups", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(temp);
        try
        {
            using var memory = new MemoryStream(clear); using var zip = new ZipArchive(memory, ZipArchiveMode.Read);
            var dump = zip.GetEntry("database.dump") ?? throw new Exception("DB 백업이 없습니다.");
            dump.ExtractToFile(Path.Combine(temp, "database.dump"));
            await StartDatabase();
            string name = "study_restore_" + DateTime.UtcNow.ToString("yyyyMMddHHmmss");
            await Run(Pg("createdb"), ["-h", "127.0.0.1", "-p", PgPort.ToString(), "-U", "study_owner", "-O", "study_app", name], PgEnv(true));
            await Run(Pg("pg_restore"), ["-h", "127.0.0.1", "-p", PgPort.ToString(), "-U", "study_app", "-d", name, "--no-owner", "--no-acl", "--exit-on-error", Path.Combine(temp, "database.dump")], PgEnv());
            // Existing DB is retained. Switch only after pg_restore completes.
            var savedEntry = zip.GetEntry("settings.json");
            if (savedEntry != null)
            {
                using var savedStream = savedEntry.Open();
                var saved = JsonSerializer.Deserialize<Settings>(savedStream);
                if (saved != null) { settings.ServiceAccountJson = saved.ServiceAccountJson; settings.NeisKey = saved.NeisKey; settings.AiKey = saved.AiKey; settings.TunnelToken = saved.TunnelToken; settings.PublicUrl = saved.PublicUrl; settings.AllowedOrigins = saved.AllowedOrigins; settings.NetworkMode = saved.NetworkMode; }
            }
            settings.DatabaseName = name; Save(); Append("새 DB로 복원 완료. 기존 DB는 보존했습니다.");
        }
        finally { CryptographicOperations.ZeroMemory(clear); DeleteBackupTemporary(temp); if (databaseStarted) await StopAsync(); }
    }

    async Task TestHttpsIsolation()
    {
        string productionConfig = Path.Combine(root, "config", "Caddyfile.production-test");
        File.WriteAllText(productionConfig, CaddyConfiguration("api.study.junhyuk.site", Port));
        var adaptInfo = new ProcessStartInfo(Path.Combine(runtime, "caddy.exe")) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (string arg in new[] { "adapt", "--config", productionConfig, "--adapter", "caddyfile" }) adaptInfo.ArgumentList.Add(arg);
        using (var adapt = Process.Start(adaptInfo) ?? throw new Exception("Caddy configuration adaptation failed"))
        {
            var output = adapt.StandardOutput.ReadToEndAsync(); var errors = adapt.StandardError.ReadToEndAsync();
            await adapt.WaitForExitAsync(); string json = await output; await errors;
            if (adapt.ExitCode != 0) throw new Exception("443-only Caddy configuration is invalid");
            using var configuration = JsonDocument.Parse(json);
            var config = configuration.RootElement;
            if (!config.GetProperty("admin").GetProperty("disabled").GetBoolean()) throw new Exception("Caddy admin listener was not disabled");
            foreach (var server in config.GetProperty("apps").GetProperty("http").GetProperty("servers").EnumerateObject())
            {
                if (!server.Value.GetProperty("automatic_https").GetProperty("disable_redirects").GetBoolean()) throw new Exception("HTTP redirects were not disabled");
                foreach (var listen in server.Value.GetProperty("listen").EnumerateArray()) if (listen.GetString() != ":443") throw new Exception("Unexpected public listener");
            }
            var issuer = config.GetProperty("apps").GetProperty("tls").GetProperty("automation").GetProperty("policies")[0].GetProperty("issuers")[0];
            if (!issuer.GetProperty("challenges").GetProperty("http").GetProperty("disabled").GetBoolean()) throw new Exception("HTTP certificate challenge was not disabled");
            if (issuer.GetProperty("challenges").TryGetProperty("tls-alpn", out var tlsAlpn) && tlsAlpn.TryGetProperty("disabled", out var disabled) && disabled.GetBoolean()) throw new Exception("TLS-ALPN certificate challenge was disabled");
        }

        var occupiedHttp = new TcpListener(IPAddress.Loopback, 0); occupiedHttp.Start();
        var httpsReservation = new TcpListener(IPAddress.Loopback, 0); httpsReservation.Start();
        int httpsPort = ((IPEndPoint)httpsReservation.LocalEndpoint).Port; httpsReservation.Stop();
        string certificateFile = Path.Combine(root, "config", "https-test.crt"), keyFile = Path.Combine(root, "config", "https-test.key");
        Process? testProxy = null;
        try
        {
            using var rsa = RSA.Create(2048);
            var request = new CertificateRequest("CN=localhost", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            var names = new SubjectAlternativeNameBuilder(); names.AddDnsName("localhost"); request.CertificateExtensions.Add(names.Build());
            using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddHours(1));
            File.WriteAllText(certificateFile, certificate.ExportCertificatePem()); File.WriteAllText(keyFile, rsa.ExportPkcs8PrivateKeyPem());
            string caddyfile = Path.Combine(root, "config", "Caddyfile.https-test");
            File.WriteAllText(caddyfile, CaddyConfiguration("localhost", Port, httpsPort, ((IPEndPoint)occupiedHttp.LocalEndpoint).Port, certificateFile, keyFile));
            testProxy = Launch(Path.Combine(runtime, "caddy.exe"), ["run", "--config", caddyfile, "--adapter", "caddyfile"]);
            byte[] pin = certificate.GetCertHash(HashAlgorithmName.SHA256);
            // Accept only this generated test certificate and a valid hostname; production validation is unchanged.
            using var handler = new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, presented, _, errors) => presented != null && (errors & ~SslPolicyErrors.RemoteCertificateChainErrors) == SslPolicyErrors.None && CryptographicOperations.FixedTimeEquals(presented.GetCertHash(HashAlgorithmName.SHA256), pin) };
            using var https = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(2) };
            bool ready = false;
            for (int attempt = 0; attempt < 30; attempt++)
            {
                if (testProxy.HasExited) throw new Exception("Caddy exited while the HTTP port was occupied");
                try { using var response = await https.GetAsync($"https://localhost:{httpsPort}/health"); if (response.IsSuccessStatusCode) { ready = true; break; } } catch { }
                await Task.Delay(200);
            }
            if (!ready) throw new Exception("HTTPS proxy failed while the HTTP port was occupied");
            File.WriteAllText(Path.Combine(root, "https-result.json"), "{\"ok\":true,\"publicListener443Only\":true,\"httpChallengeDisabled\":true,\"tlsAlpnAvailable\":true,\"adminListenerDisabled\":true,\"occupiedHttpPortPreserved\":true,\"httpsHealth\":true}");
        }
        finally
        {
            if (testProxy is { HasExited: false }) { testProxy.Kill(true); await testProxy.WaitForExitAsync(); }
            occupiedHttp.Stop(); httpsReservation.Stop(); if (File.Exists(keyFile)) File.Delete(keyFile);
        }
    }

    async Task SelfTest()
    {
        Directory.CreateDirectory(Path.Combine(root, "config")); Directory.CreateDirectory(Path.Combine(root, "logs"));
        string ownerPassword = settings.OwnerPassword, appPassword = settings.AppPassword;
        if (ApplyEmbeddedSettings(settings))
        {
            if (settings.OwnerPassword != ownerPassword || settings.AppPassword != appPassword) throw new Exception("Embedded settings replaced local database credentials");
            using var certificate = JsonDocument.Parse(settings.ServiceAccountJson);
            if (certificate.RootElement.GetProperty("type").GetString() != "service_account") throw new Exception("Embedded Firebase account is invalid");
            using var privateKey = RSA.Create(); privateKey.ImportFromPem(certificate.RootElement.GetProperty("private_key").GetString()!);
            Save();
            var restored = JsonSerializer.Deserialize<Settings>(Unprotect(File.ReadAllBytes(ConfigPath)))!;
            if (restored.ServiceAccountJson != settings.ServiceAccountJson || restored.NeisKey != settings.NeisKey || restored.AiKey != settings.AiKey) throw new Exception("Embedded settings were not protected for the new Windows user");
            var existing = new Settings { ServiceAccountJson = "existing", NeisKey = "existing", AiKey = "existing" };
            ApplyEmbeddedSettings(existing);
            if (existing.ServiceAccountJson != "existing" || existing.NeisKey != "existing" || existing.AiKey != "existing") throw new Exception("Embedded settings overwrote existing local configuration");
            File.WriteAllText(Path.Combine(root, "embedded-settings-result.json"), "{\"ok\":true,\"firebasePrivateKeyValid\":true,\"neisConfigured\":true,\"aiConfigured\":true,\"newUserProtection\":true,\"existingSettingsPreserved\":true,\"localDatabasePasswordsPreserved\":true}");
        }
        await ExtractAsync(); await StartDatabase();
        api = Launch(Path.Combine(runtime, "node", "node.exe"), [Path.Combine(runtime, "functions", "selfhost-entry.js")], new() {
            ["STUDY_BACKEND"] = "selfhost", ["GCLOUD_PROJECT"] = "demo-study", ["STUDY_PORT"] = Port.ToString(),
            ["DATABASE_URL"] = $"postgresql://study_app:{settings.AppPassword}@127.0.0.1:{PgPort}/{settings.DatabaseName}"
        });
        bool ready = false;
        for (int i = 0; i < 60; i++) { try { using var response = await client.GetAsync(LocalUrl + "/health"); if (response.IsSuccessStatusCode) { ready = true; break; } } catch { } if (api.HasExited) break; await Task.Delay(500); }
        if (!ready) throw new Exception("Bundled API health check failed");
        await TestHttpsIsolation();
        using (var response = await client.PostAsync(LocalUrl + "/api/v1/read", new StringContent("{}", Encoding.UTF8, "application/json"))) if (response.StatusCode != HttpStatusCode.Unauthorized) throw new Exception("Unauthenticated API was not rejected");
        string dump = Path.Combine(root, "test.dump");
        await Run(Pg("pg_dump"), ["-h", "127.0.0.1", "-p", PgPort.ToString(), "-U", "study_app", "-d", "study", "-F", "c", "--no-owner", "-f", dump], PgEnv());
        await Run(Pg("createdb"), ["-h", "127.0.0.1", "-p", PgPort.ToString(), "-U", "study_owner", "-O", "study_app", "study_selftest_restore"], PgEnv(true));
        await Run(Pg("pg_restore"), ["-h", "127.0.0.1", "-p", PgPort.ToString(), "-U", "study_app", "-d", "study_selftest_restore", "--no-owner", "--no-acl", "--exit-on-error", dump], PgEnv());
        byte[] original = Encoding.UTF8.GetBytes("STUDY backup round trip");
        byte[] encrypted = CryptBackup(original, "test-only-password", false);
        if (!CryptBackup(encrypted, "test-only-password", true).AsSpan().SequenceEqual(original)) throw new Exception("Backup encryption round trip failed");
        try { CryptBackup(encrypted, "wrong-password", true); throw new Exception("Wrong backup password accepted"); } catch (CryptographicException) { }
        status.Text = "서버 실행 검증 완료"; using (var image = new Bitmap(Width, Height)) { DrawToBitmap(image, new Rectangle(0, 0, Width, Height)); image.Save(Path.Combine(root, "launcher.png")); }
        await StopAsync();
    }
}
