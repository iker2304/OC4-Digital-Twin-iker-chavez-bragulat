import cv2
import numpy as np
import math

def rodriguez_exponential(rvec: np.ndarray) -> np.ndarray:
    rvec = np.array(rvec, dtype=np.float64)

    # Total magnitude of the rotation
    theta = np.linalg.norm(rvec)

    if theta < 1e-8:
        return np.identity(3)
    
    # Normalization of the rotation axis
    k = (rvec / theta).flatten()
    
    # Asimetric matrix (K)
    asimetric_matrix = np.array([
        [0, -k[2], k[1]],
        [k[2], 0, -k[0]],
        [-k[1], k[0], 0]
    ])
    
    # Rodrigues exponential (R)
    R = (np.identity(3) 
        + np.sin(theta) * asimetric_matrix 
        + (1 - np.cos(theta)) * asimetric_matrix @ asimetric_matrix)
    
    return R

def euler_angles(R: np.ndarray) -> tuple:
    """
    Euler angles (ZYX convention):
    Yaw (Z), Pitch (Y), Roll (X)
    Angles expressed in degrees.
    """
    
    sy = np.sqrt(R[0,0]**2 + R[1,0]**2)
    singular = sy < 1e-6

    if not singular:
        roll  = math.atan2(R[2,1], R[2,2])
        pitch = math.atan2(-R[2,0], sy)
        yaw   = math.atan2(R[1,0], R[0,0])
    else:
        roll  = math.atan2(-R[1,2], R[1,1])
        pitch = math.atan2(-R[2,0], sy)
        yaw   = 0

    return (round(math.degrees(pitch),3),
            round(math.degrees(roll),3),
            round(math.degrees(yaw),3))

def distance(cfg, tvec: np.ndarray, R: np.ndarray) -> tuple:
    """
    Distance of the OC4 platform with respect to the camera.
    Input tvec is assumed to be in Meters (based on 3D_points.json).
    """
    # We use tvec directly for object position relative to camera
    # tvec shape is (3, 1)
    x = tvec[0][0]
    y = tvec[1][0]
    z = tvec[2][0]

    factor = 1.0
    if cfg.orientation.units == "m":
        factor = 1.0
    elif cfg.orientation.units == "cm":
        factor = 100.0
    elif cfg.orientation.units == "mm":
        factor = 1000.0

    x_distance = x * factor
    y_distance = y * factor
    z_distance = z * factor
    
    global_distance = np.sqrt(x_distance**2 + y_distance**2 + z_distance**2)

    return (round(float(global_distance), 3),
            round(float(x_distance),3),
            round(float(y_distance),3),
            round(float(z_distance),3))

class PoseTracker:
    def __init__(self, cfg):
        self.cfg = cfg
        self.R0 = None # First rotation matrix for reference

    def update(self, rvec, tvec): 
        Rt = rodriguez_exponential(rvec)

        # Saves first frame
        if self.R0 is None:
            self.R0 = Rt
        
        # Relative rotation with respect to the first frame
        R_rel = self.R0.T @ Rt

        # Euler angles (ZYX convention)
        pitch, roll, yaw = euler_angles(R_rel)

        # Relative distance
        dists = distance(self.cfg, tvec, R_rel)
        
        return pitch, roll, yaw, dists
