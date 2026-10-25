"""OmicOS OSS persistent Python worker. Trusted code execution, NOT a sandbox.
The wire runs on inherited fd 3, isolated from Python/user stdout and stderr.
No automatic dependency installation, data upload or object unpickling.
"""
import ast
import contextlib
import hashlib
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

emit({'type': 'ready', 'python': sys.version.split()[0]})
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
            if 'matplotlib.pyplot' in sys.modules:
                plt = sys.modules['matplotlib.pyplot']
                directory = workspace / '.omicos-oss' / 'artifacts' / current
                for index, number in enumerate(plt.get_fignums()):
                    directory.mkdir(parents=True, exist_ok=True)
                    file = directory / ('figure-%s.png' % index)
                    plt.figure(number).savefig(file, dpi=150, bbox_inches='tight')
                    data = file.read_bytes()
                    artifacts.append({'id': '%s-%s' % (current, index), 'path': str(file.relative_to(workspace)), 'mime': 'image/png', 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
                plt.close('all')
        except KeyboardInterrupt:
            canceled = True
            error = 'Execution canceled; partial changes may remain in the Python namespace.'
        except BaseException:
            error = traceback.format_exc(limit=12)
    emit({'id': current, 'type': 'done', 'error': error, 'canceled': canceled, 'variables': variables(), 'artifacts': artifacts})
    current = None
