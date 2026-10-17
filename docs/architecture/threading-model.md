# Architecture: Threading & Concurrency Model (`threading-model.md`)

## 1. ONNX Runtime CPU Thread Safety
`onnxruntime.InferenceSession` is thread-safe for concurrent `.run()` calls ONLY when properly configured, and unconstrained thread spawning causes severe CPU contention on quad-core laptops.

### Mandatory SessionOptions Configuration:
```python
import os
import onnxruntime as ort

cpu_cores = os.cpu_count() or 4
sess_options = ort.SessionOptions()
# Prevent thread oversubscription on dual/quad-core CPUs
sess_options.intra_op_num_threads = max(1, cpu_cores // 2)
sess_options.inter_op_num_threads = 1
sess_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
```

## 2. FastAPI Async Loop vs. CPU-Bound Inference
- FastAPI runs on an `asyncio` event loop. Running ONNX or `mishkal` directly inside an `async def` endpoint blocks the event loop and freezes `/health` heartbeats and SSE streams.
- **Rule:** All inference calls (`catt_onnx`, `libtashkeel`, `mishkal`, and `python-docx` XML parsing) MUST be dispatched via `asyncio.get_running_loop().run_in_executor(inference_ThreadPoolExecutor, ...)` using a bounded `ThreadPoolExecutor(max_workers=2)`.

## 3. SQLite Concurrency
- SQLite is initialized with:
  - `PRAGMA journal_mode=WAL;`
  - `PRAGMA synchronous=NORMAL;`
  - `PRAGMA busy_timeout=5000;`
  - `PRAGMA foreign_keys=ON;`
- Writes are serialized through a dedicated database helper context manager with automatic retry on `sqlite3.OperationalError` (`database is locked`).
