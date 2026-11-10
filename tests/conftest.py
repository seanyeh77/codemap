import os

# indexing a fixture must not leave a TypeScript program cache in it; the cache's own test turns it on
os.environ.setdefault("CODEMAP_TS_CACHE", "0")
