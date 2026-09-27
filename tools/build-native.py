"""Run MSBuild with case-normalized environment keys (Windows Path/PATH)."""
import os, subprocess, sys, shutil
from pathlib import Path
root = Path(__file__).resolve().parents[1]
configured = os.environ.get('MSBUILD_EXE') or shutil.which('MSBuild.exe')
if not configured:
    vswhere = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)')) / 'Microsoft Visual Studio/Installer/vswhere.exe'
    if vswhere.is_file():
        matches = subprocess.check_output([str(vswhere), '-latest', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild/Current/Bin/MSBuild.exe'], text=True).strip().splitlines()
        configured = matches[0] if matches else None
if not configured or not Path(configured).is_file():
    sys.exit('MSBuild not found. Install the documented C++ prerequisites or set MSBUILD_EXE.')
msbuild = Path(configured)
env = {k.upper(): v for k, v in os.environ.items()}
env['Path'] = str(root/'packages/build-tools') + ';' + str(root/'packages/build-tools/nasm-2.16.03') + ';' + env.pop('PATH', '')
git = shutil.which('git.exe') or shutil.which('git')
if git:
    env['MPCHC_GIT'] = str(Path(git).resolve().parent.parent)
with (root / 'native-build.log').open('w', encoding='utf-8') as log:
    result = subprocess.run([str(msbuild), str(root/'mpc-hc.sln'), '/t:Build',
        '/p:Configuration=Release Lite', '/p:Platform=x64', '/p:MPCHC_WINSDK_VER=10.0', '/p:UseNativeEnvironment=false',
        '/m:2', '/verbosity:minimal', '/nologo'], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
print(f'MSBuild exit {result.returncode}; log: {root / "native-build.log"}')
sys.exit(result.returncode)
