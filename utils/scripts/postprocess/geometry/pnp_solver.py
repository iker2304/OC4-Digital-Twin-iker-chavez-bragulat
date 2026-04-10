import cv2
import numpy as np
import json
import os
import sys

def load_3d_points(cfg) -> dict:
    with open(cfg.pnp.paths.points_3d, 'r') as f:
        points_3d = json.load(f)
    return points_3d

def load_intrinsic_matrix(cfg) -> np.ndarray:
    with open(cfg.pnp.paths.intrinsic_matrix, 'r') as f:
        intr_matrix = json.load(f)
        intrinsic_matrix = np.array(intr_matrix['intrinsic_matrix'], dtype=np.float32)
    return intrinsic_matrix

def load_distortion_coefficients(cfg) -> np.ndarray:
    with open(cfg.pnp.paths.intrinsic_matrix, 'r') as f:
        dist_coefficients = json.load(f)
        distortion_coefficients = dist_coefficients['distortion_coefficients']
    return distortion_coefficients

def match_points(cfg, points_3d: dict, detections_2d: dict) -> tuple:

    pts_3d = [] # List of 3D points [X, Y, Z]
    pts_2d = [] # List of 2D points [X, Y]
    pts_used = [] # List of names of used points

    for name, data_2d in detections_2d.items():
        # Exclude Blade points because they re dynamic
        if "Blade" in name:
            continue

        if name in points_3d and data_2d.get('confidence', 1) > cfg.pnp.config.confidence_threshold:
            # Extract 3D point from model
            p3 = points_3d[name]
            pts_3d.append([p3['x'], p3['y'], p3['z']])

            # Extract 2D point from detection
            pts_2d.append([data_2d['x'], data_2d['y']])
            
            # Add used point to list
            pts_used.append(name)

    return (np.array(pts_3d, dtype=np.float32), 
            np.array(pts_2d, dtype=np.float32), 
            pts_used)

def pnp_solver(cfg, pts_3d: np.ndarray, pts_2d: np.ndarray, intrinsic_matrix: np.ndarray, distortion_coefficients: np.ndarray) -> tuple:
    # Convert intrinsic matrix to numpy array
    intrinsic_matrix = np.array(intrinsic_matrix, dtype=np.float32)
    # Convert distortion coefficients to numpy array
    distortion_coefficients = np.array(distortion_coefficients, dtype=np.float32)

    # PnP solver with increased tolerance for high-res images
    success, rvec, tvec, inliers = cv2.solvePnPRansac(
        pts_3d, 
        pts_2d, 
        intrinsic_matrix, 
        distortion_coefficients,
        flags=cv2.SOLVEPNP_EPNP, 
        reprojectionError=50.0, 
        iterationsCount=100
    )
    
    if success: 
        # rvec -> rotation vector
        # tvec -> translation vector
        return rvec, tvec
    else:
        return None, None    



    
    