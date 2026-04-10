import cv2
import numpy as np

class KeypointKalmanFilter:
    def __init__(self, initial_x, initial_y):
        self.kalman = cv2.KalmanFilter(4, 2)
        self.kalman.measurementMatrix = np.array([[1, 0, 0, 0],
                                                  [0, 1, 0, 0]], np.float32)
        self.kalman.transitionMatrix = np.array([[1, 0, 1, 0],
                                                 [0, 1, 0, 1],
                                                 [0, 0, 1, 0],
                                                 [0, 0, 0, 1]], np.float32)
        self.kalman.processNoiseCov = np.eye(4, dtype=np.float32) * 0.03
        self.kalman.measurementNoiseCov = np.eye(2, dtype=np.float32) * 1.0 
        self.kalman.errorCovPost = np.eye(4, dtype=np.float32) * 1.0
        
        # Initialize state
        self.kalman.statePost = np.array([[initial_x], [initial_y], [0], [0]], dtype=np.float32)
        self.kalman.statePre = self.kalman.statePost.copy()

    def update(self, x, y):
        measurement = np.array([[np.float32(x)], [np.float32(y)]])
        self.kalman.correct(measurement)
        prediction = self.kalman.predict()
        # Handle both (N, 1) and (N,) shapes safely
        px = prediction[0] if prediction.ndim == 1 else prediction[0, 0]
        py = prediction[1] if prediction.ndim == 1 else prediction[1, 0]
        return float(px), float(py)
    
    def predict(self):
        prediction = self.kalman.predict()
        # Handle both (N, 1) and (N,) shapes safely
        px = prediction[0] if prediction.ndim == 1 else prediction[0, 0]
        py = prediction[1] if prediction.ndim == 1 else prediction[1, 0]
        return float(px), float(py)

class KeypointSmoother:
    def __init__(self):
    
        self.filters = {} 
        self.last_seen = {} 

    def update(self, track_id, keypoint_index, x, y):
        if track_id not in self.filters:
            self.filters[track_id] = {}
        
        if keypoint_index not in self.filters[track_id]:
            self.filters[track_id][keypoint_index] = KeypointKalmanFilter(x, y)
        
        return self.filters[track_id][keypoint_index].update(x, y)
