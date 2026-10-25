"""OmicOS OSS persistent Python worker. Trusted code execution, NOT a sandbox.
The wire runs on inherited fd 3, isolated from Python/user stdout and stderr.
No automatic dependency installation, data upload or object unpickling.
"""
import ast
import contextlib
import hashlib
import importlib.metadata as package_metadata
import json
import os
from pathlib import Path
import signal
import sys
import traceback

wire = os.fdopen(3, 'w', buffering=1, encoding='utf-8')
workspace = Path(sys.argv[1]).resolve()
os.chdir(workspace)
namespace = {'__name__': '__main__', '__builtins__': __builtins__}
current = None

def emit(value):
    wire.write(json.dumps(value, ensure_ascii=True, default=str) + '\n')
    wire.flush()

class Output:
    def write(self, text):
        if text:
            emit({'id': current, 'type': 'output', 'text': str(text)[:65536]})
        return len(text)
    def flush(self):
        pass
    def isatty(self):
        return False

def variables():
    result = []
    for name, value in list(namespace.items()):
        if name.startswith('_'):
            continue
        try:
            shape = getattr(value, 'shape', None)
            # Avoid arbitrary __repr__ on large scientific objects.
            preview = (type(value).__name__ + '(len=' + str(len(value)) + ')') if type(value) in (list, tuple, dict, set) else repr(value[:200] if type(value) is str else value)[:200] if type(value) in (str, int, float, bool, type(None)) else type(value).__name__
            result.append({'name': name, 'type': type(value).__name__, 'shape': str(shape) if shape is not None else None, 'preview': preview})
        except Exception:
            result.append({'name': name, 'type': type(value).__name__, 'preview': '<unavailable>'})
    return result[:500]

packages = {}
for name in ['numpy', 'pandas', 'scipy', 'anndata', 'scanpy', 'omicverse', 'matplotlib']:
    try:
        packages[name] = package_metadata.version(name)
    except package_metadata.PackageNotFoundError:
        packages[name] = None
    except Exception:
        packages[name] = 'unavailable'
emit({'type': 'ready', 'environment': {'language': 'python', 'version': sys.version.split()[0], 'executable': sys.executable, 'platform': sys.platform, 'packages': packages}})
for line in sys.stdin:
    command = json.loads(line)
    current = command['id']
    artifacts = []
    error = None
    canceled = False
    with contextlib.redirect_stdout(Output()), contextlib.redirect_stderr(Output()):
        try:
            tree = ast.parse(command['code'], filename='<omicos-cell>', mode='exec')
            final = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
            exec(compile(tree, '<omicos-cell>', 'exec'), namespace)
            if final is not None:
                result = eval(compile(ast.Expression(final.value), '<omicos-cell>', 'eval'), namespace)
                if result is not None:
                    print(repr(result)[:65536])
        except KeyboardInterrupt:
            canceled = True
            error = 'Execution canceled; partial changes may remain in the Python namespace.'
        except BaseException:
            error = traceback.format_exc(limit=12)
        try:
            if not canceled and 'matplotlib.pyplot' in sys.modules:
                plt = sys.modules['matplotlib.pyplot']
                directory = workspace / '.omicos-oss' / 'artifacts' / current
                for index, number in enumerate(plt.get_fignums()):
                    directory.mkdir(parents=True, exist_ok=True)
                    for extension, mime in [('png', 'image/png'), ('pdf', 'application/pdf'), ('svg', 'image/svg+xml')]:
                        file = directory / ('figure-%s.%s' % (index, extension))
                        plt.figure(number).savefig(file, dpi=150, bbox_inches='tight')
                        data = file.read_bytes()
                        artifact_id = '%s-%s' % (current, index) if extension == 'png' else '%s-%s-%s' % (current, index, extension)
                        artifacts.append({'id': artifact_id, 'path': str(file.relative_to(workspace)), 'mime': mime, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
        except KeyboardInterrupt:
            canceled = True
            error = (error + '\n' if error else '') + 'Figure capture canceled; partial results may remain.'
        except BaseException:
            error = (error + '\n' if error else '') + 'Figure capture failed: ' + traceback.format_exc(limit=8)
        finally:
            if 'matplotlib.pyplot' in sys.modules:
                try:
                    sys.modules['matplotlib.pyplot'].close('all')
                except BaseException:
                    error = (error + '\n' if error else '') + 'Figure cleanup failed: ' + traceback.format_exc(limit=4)
    emit({'id': current, 'type': 'done', 'error': error, 'canceled': canceled, 'variables': variables(), 'artifacts': artifacts})
    current = None
