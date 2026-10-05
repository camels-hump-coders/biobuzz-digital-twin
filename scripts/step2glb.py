import sys, time, numpy as np, trimesh
import cadquery as cq
src, dst = sys.argv[1], sys.argv[2]
min_diag = float(sys.argv[3]) if len(sys.argv) > 3 else 10.0  # mm
t0 = time.time()
wp = cq.importers.importStep(src)
print("imported", time.time()-t0, flush=True)
solids = wp.solids().vals()
print("solids", len(solids), flush=True)
meshes = []
skipped = 0
for i, s in enumerate(solids):
    bb = s.BoundingBox()
    diag = ((bb.xlen)**2 + (bb.ylen)**2 + (bb.zlen)**2) ** 0.5
    if diag < min_diag:
        skipped += 1
        continue
    try:
        verts, tris = s.tessellate(0.4, 0.5)
    except Exception as e:
        print("tess fail", i, e, flush=True); continue
    if not tris: continue
    v = np.array([[p.x, p.y, p.z] for p in verts], dtype=np.float32)
    f = np.array(tris, dtype=np.int64)
    meshes.append(trimesh.Trimesh(vertices=v, faces=f, process=False))
    if i % 50 == 0: print("tess", i, "/", len(solids), time.time()-t0, flush=True)
print("skipped", skipped, "kept", len(meshes), flush=True)
m = trimesh.util.concatenate(meshes)
print("faces", len(m.faces), "bbox(mm)", m.bounds.tolist(), flush=True)
m.export(dst)
print("wrote", dst, time.time()-t0, flush=True)
