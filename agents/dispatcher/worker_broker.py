"""Windows broker for a dedicated WSL worker; provider credentials stay out of argv/logs."""
import json, os, pathlib, re, subprocess, sys, threading, time, tomllib, urllib.request

WSL = str(pathlib.Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32/wsl.exe')
SCRIPT = '/opt/leitstand-worker/wsl_worker.py'
RUNTIME = pathlib.Path.home() / '.leitstand'

def report(job, platform, kind, status):
    if platform not in ('codex', 'claude-code'): return
    try:
        config = json.loads((RUNTIME / ('codex.json' if platform == 'codex' else 'claude.json')).read_text())
        data = {'agent_id': config['MC_AGENT'], 'display_name': config['MC_AGENT_NAME'],
                'machine': 'weltogeisto', 'platform': platform, 'session_id': 'isolated-' + job,
                'kind': kind, 'status': status, 'title': 'Isolated worker ' + status,
                'project': 'leitstand', 'detail': {'isolated': True}}
        req = urllib.request.Request(config['MC_URL'].rstrip('/') + '/api/ingest', data=json.dumps(data).encode(),
                headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['MC_TOKEN']})
        with urllib.request.urlopen(req, timeout=8) as response: response.read()
    except Exception:
        print('[worker] Status reporting unavailable', file=sys.stderr)

def linux_path(path):
    value = str(path.resolve()).replace('\\', '/')
    if not value.lower().startswith('c:/'): raise ValueError('Only the configured C: workspace is supported')
    return '/mnt/c/' + value[3:]

def payload(platform, args):
    cwd = pathlib.Path.cwd().resolve()
    root = pathlib.Path('C:/AI/leitstand-worktrees').resolve()
    if not cwd.is_relative_to(root) or cwd == root: raise ValueError('Worker cwd is not an approved worktree')
    def git(*cmd): return pathlib.Path(subprocess.check_output(['git', '-C', str(cwd), *cmd], text=True).strip()).resolve()
    common = git('rev-parse', '--path-format=absolute', '--git-common-dir')
    metadata = git('rev-parse', '--absolute-git-dir')
    if not common.is_relative_to(pathlib.Path('C:/AI/projects').resolve()) or common.name != '.git':
        raise ValueError('Git common directory is outside the approved projects')
    if not metadata.is_relative_to(common / 'worktrees'): raise ValueError('Not a linked worktree')
    auth = {}
    codex = pathlib.Path.home() / '.codex/auth.json'
    claude = pathlib.Path.home() / '.claude/.credentials.json'
    if platform == 'codex' and codex.exists(): auth['codex'] = json.loads(codex.read_text())
    if platform == 'claude-code' and claude.exists():
        credentials = json.loads(claude.read_text())
        if 'claudeAiOauth' in credentials: auth['claude'] = {'claudeAiOauth': credentials['claudeAiOauth']}
    config_path = pathlib.Path.home() / '.codex/config.toml'
    config = tomllib.loads(config_path.read_text()) if config_path.exists() else {}
    settings = {name: config[name] for name in ('model', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity') if isinstance(config.get(name), str)}
    return {'cwd': linux_path(cwd), 'git_common': linux_path(common), 'git_dir': linux_path(metadata),
            'platform': platform, 'args': args, 'auth': auth, 'codex_settings': settings}

def main():
    action, job = sys.argv[1:3]
    if not re.fullmatch('[a-f0-9]{32}', job): raise ValueError('Invalid job identifier')
    registry = RUNTIME / 'worker-jobs'
    registry.mkdir(exist_ok=True)
    state = registry / (job + '.json')
    command = [WSL, '--distribution', 'Ubuntu-24.04', '--user', 'root', '--exec', '/usr/bin/python3', SCRIPT, action, job]
    if action == 'stop':
        result = subprocess.call(command, stdin=subprocess.DEVNULL)
        if result == 0 and state.exists():
            report(job, json.loads(state.read_text())['platform'], 'session_end', 'failed')
            state.unlink(missing_ok=True)
        return result
    if action != 'run': raise ValueError('Invalid action')
    platform = sys.argv[3]
    data = payload(platform, sys.argv[4:])
    if platform != 'doctor':
        state.write_text(json.dumps({'platform': platform}))
        report(job, platform, 'session_start', 'active')
    proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=sys.stdout.buffer, stderr=sys.stderr.buffer)
    proc.stdin.write((json.dumps(data) + '\n').encode()); proc.stdin.flush()
    stopped = threading.Event()
    def heartbeat():
        count = 0
        while not stopped.wait(1):
            try: proc.stdin.write(b'{}\n'); proc.stdin.flush()
            except (BrokenPipeError, OSError, ValueError): return
            count += 1
            if count % 30 == 0: report(job, platform, 'heartbeat', 'active')
    thread = threading.Thread(target=heartbeat, daemon=True); thread.start()
    try:
        result = proc.wait()
        return result
    finally:
        stopped.set(); thread.join(timeout=2)
        try: proc.stdin.close()
        except OSError: pass
        report(job, platform, 'session_end', 'done' if proc.returncode == 0 else 'failed')
        state.unlink(missing_ok=True)

if __name__ == '__main__':
    raise SystemExit(main())
