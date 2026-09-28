"""Compile and run the bounded PCM fixture; no player or graphics runtime."""
import os, subprocess, sys, shutil
from pathlib import Path
root = Path(__file__).resolve().parents[1]
vswhere = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)')) / 'Microsoft Visual Studio/Installer/vswhere.exe'
install = subprocess.check_output([str(vswhere), '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], text=True).strip()
if not install:
    sys.exit('Visual Studio C++ build tools not found')
setup = Path(install) / 'Common7/Tools/VsDevCmd.bat'
command = f'""{setup}" -no_logo -arch=x64 >nul && set"'
environment = subprocess.check_output('cmd.exe /d /s /c ' + command, text=True)
env = {k.upper(): v for k, v in os.environ.items()}
for line in environment.splitlines():
    key, sep, value = line.partition('=')
    if sep and key: env[key.upper()] = value
fixture = 'library' if '--library' in sys.argv else 'audio'
output = root / ('.tmp/' + fixture + '-check')
output.mkdir(parents=True, exist_ok=True)
compiler = shutil.which('cl.exe', path=env.get('PATH'))
if not compiler: sys.exit('C++ compiler missing from Visual Studio environment')
subprocess.run([compiler, '/nologo', '/std:c++17', '/EHsc', '/W4', '/UNDEBUG', str(root/('tools/check-aaavs-' + fixture + '.cpp')), '/Fe:check-aaavs-' + fixture + '.exe', '/Fo:check-aaavs-' + fixture + '.obj'], cwd=output, env=env, check=True)
subprocess.run([str(output/('check-aaavs-' + fixture + '.exe'))], cwd=output, env=env, check=True)
