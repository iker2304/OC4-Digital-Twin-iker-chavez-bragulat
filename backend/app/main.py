from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.video.stream import router as video_router
from app.api.twin import router as twin_router
from app.api.shm import router as shm_router
from app.api.dataset import router as dataset_router
from app.api.persist import router as persist_router
from app.api.auth import router as auth_router
from app.api.flow_router import router as flow_router
from app.api.sse import router as sse_router
from app.api.mqtt_router import router as mqtt_router
from app.api.fem import router as fem_router

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(video_router, prefix="/video", tags=["video"])
app.include_router(twin_router)
app.include_router(shm_router, tags=["shm"])
app.include_router(dataset_router, prefix="/dataset", tags=["dataset"])
app.include_router(persist_router, prefix="/persist", tags=["persist"])
app.include_router(auth_router, prefix="/api", tags=["auth"])
app.include_router(flow_router, prefix="/api/flow", tags=["flow"])
app.include_router(sse_router, prefix="/api", tags=["sse"])
app.include_router(mqtt_router, prefix="/api/mqtt", tags=["mqtt"])
app.include_router(fem_router, prefix="/api/fem", tags=["fem"])
