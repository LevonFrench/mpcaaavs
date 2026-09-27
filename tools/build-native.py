"""Run MSBuild with case-normalized environment keys (Windows Path/PATH)."""
import os, subprocess, sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
msbuild = Path('C:/Program Files/Microsoft Visual Studio/2022/Community/MSBuild/Current/Bin/MSBuild.exe')
env = {k.upper(): v for k, v in os.environ.items()}
env['Path'] = str(root/'packages/build-tools') + ';' + str(root/'packages/build-tools/nasm-2.16.03') + ';' + env.pop('PATH', '')
env['MPCHC_GIT'] = 'C:\\Program Files\\Git'
with (root / 'native-build.log').open('w', encoding='utf-8') as log:
    result = subprocess.run([str(msbuild), str(root/'mpc-hc.sln'), '/t:Build',
        '/p:Configuration=Release Lite', '/p:Platform=x64', '/p:MPCHC_WINSDK_VER=10.0', '/p:UseNativeEnvironment=false',
        '/m:2', '/verbosity:minimal', '/nologo'], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
print(f'MSBuild exit {result.returncode}; log: {root / "native-build.log"}')
sys.exit(result.returncode)
