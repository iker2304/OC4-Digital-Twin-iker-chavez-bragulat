import cv2
import time
import threading
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

router = APIRouter()

class VideoCamera:
    def __init__(self):
        # 0 is usually the default webcam
        # Disabled to allow pose_detection.py to control the camera exclusively
        # self.video = cv2.VideoCapture(0)
        self.video = None
        self.lock = threading.Lock()
    
    def __del__(self):
        if self.video:
            self.video.release()
    
    def get_frame(self):
        if self.video is None:
            return None

        with self.lock:
            success, image = self.video.read()
            if not success:
                return None
            
            # Encode frame as JPEG
            ret, jpeg = cv2.imencode('.jpg', image)
            return jpeg.tobytes()

# Global camera instance (singleton pattern for simplicity in this context)
camera = VideoCamera()

def gen_frames():
    while True:
        frame = camera.get_frame()
        if frame is None:
            time.sleep(0.1)
            continue
            
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n\r\n')

@router.get("/video_feed")
async def video_feed():
    return StreamingResponse(gen_frames(),
                             media_type="multipart/x-mixed-replace; boundary=frame")
