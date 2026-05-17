import cv2
import numpy as np


class KeypointKalmanFilter:
    """Constant-velocity Kalman filter for a single 2-D keypoint.

    State:   [x, y, vx, vy]
    Measure: [x, y]

    Parameters
    ----------
    process_noise:
        Q diagonal value — how much the keypoint can move between frames.
        Lower → smoother but laggier. Higher → follows detections more closely.
    measurement_noise:
        R diagonal value — expected YOLO pixel noise variance.
        Higher → trusts the model more, filters more aggressively.
    """

    def __init__(self, initial_x: float, initial_y: float,
                 process_noise: float = 0.03,
                 measurement_noise: float = 1.0) -> None:
        self.kalman = cv2.KalmanFilter(4, 2)
        self.kalman.measurementMatrix = np.array([[1, 0, 0, 0],
                                                  [0, 1, 0, 0]], np.float32)
        self.kalman.transitionMatrix = np.array([[1, 0, 1, 0],
                                                 [0, 1, 0, 1],
                                                 [0, 0, 1, 0],
                                                 [0, 0, 0, 1]], np.float32)
        self.kalman.processNoiseCov     = np.eye(4, dtype=np.float32) * process_noise
        self.kalman.measurementNoiseCov = np.eye(2, dtype=np.float32) * measurement_noise
        self.kalman.errorCovPost        = np.eye(4, dtype=np.float32) * 1.0
        self.kalman.statePost = np.array([[initial_x], [initial_y], [0], [0]], dtype=np.float32)
        self.kalman.statePre  = self.kalman.statePost.copy()

    def update(self, x: float, y: float):
        measurement = np.array([[np.float32(x)], [np.float32(y)]])
        self.kalman.correct(measurement)
        prediction = self.kalman.predict()
        px = prediction[0] if prediction.ndim == 1 else prediction[0, 0]
        py = prediction[1] if prediction.ndim == 1 else prediction[1, 0]
        return float(px), float(py)

    def predict(self):
        prediction = self.kalman.predict()
        px = prediction[0] if prediction.ndim == 1 else prediction[0, 0]
        py = prediction[1] if prediction.ndim == 1 else prediction[1, 0]
        return float(px), float(py)


class KeypointSmoother:
    """Manages one KeypointKalmanFilter per (track_id, keypoint_index) pair.

    Parameters
    ----------
    enabled:
        If False, update() returns the raw measurement unchanged.
    process_noise:
        Passed to each KeypointKalmanFilter as Q.
    measurement_noise:
        Passed to each KeypointKalmanFilter as R.
    """

    def __init__(self, enabled: bool = True,
                 process_noise: float = 0.03,
                 measurement_noise: float = 1.0) -> None:
        self.enabled          = enabled
        self.process_noise    = process_noise
        self.measurement_noise = measurement_noise
        self.filters: dict    = {}

    def update(self, track_id, keypoint_index, x: float, y: float):
        if not self.enabled:
            return x, y

        if track_id not in self.filters:
            self.filters[track_id] = {}

        if keypoint_index not in self.filters[track_id]:
            self.filters[track_id][keypoint_index] = KeypointKalmanFilter(
                x, y,
                process_noise=self.process_noise,
                measurement_noise=self.measurement_noise,
            )

        return self.filters[track_id][keypoint_index].update(x, y)
