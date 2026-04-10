import cv2
import numpy as np
import os
from pathlib import Path

def generate_chessboard_image(dimensions, square_size_px, output_path):
    """
    Generate a synthetic chessboard image for reference or printing.
    dimensions: (cols, rows) - integer tuple of inner corners
    """
    cols, rows = dimensions
    width = (cols + 1) * square_size_px
    height = (rows + 1) * square_size_px
    image = np.full((height, width), 255, dtype=np.uint8)
    
    for r in range(rows + 1):
        for c in range(cols + 1):
            if (r + c) % 2 == 1:
                start_x = c * square_size_px
                start_y = r * square_size_px
                cv2.rectangle(image, (start_x, start_y), 
                              (start_x + square_size_px, start_y + square_size_px), 255, -1)
                
                if (r + c) % 2 == 1:
                     cv2.rectangle(image, (start_x, start_y), 
                              (start_x + square_size_px, start_y + square_size_px), 0, -1)
    
    board = np.zeros((width, height), dtype=np.uint8)
    board[:] = 255
    
    image = np.zeros((height, width), dtype=np.uint8)
    image.fill(255)
    
    for i in range(0, width, square_size_px):
        for j in range(0, height, square_size_px):
            if (int(i/square_size_px) + int(j/square_size_px)) % 2 == 1:
                 cv2.rectangle(image, (i, j), (i + square_size_px, j + square_size_px), 0, -1)
                 
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    cv2.imwrite(output_path, image)
    print(f"Saved reference chessboard to {output_path}")


def calibrate_camera(image_files, board_size, square_size_mm):
    """
    Calibrate camera using a list of image paths.
    board_size: (cols, rows) e.g., (9, 6)
    square_size_mm: float size of one square in real world
    """

    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)

    objp = np.zeros((board_size[1] * board_size[0], 3), np.float32)
    objp[:, :2] = np.mgrid[0:board_size[0], 0:board_size[1]].T.reshape(-1, 2)
    objp = objp * square_size_mm

    # Arrays to store object points and image points from all the images.
    objpoints = [] # 3d point in real world space
    imgpoints = [] # 2d points in image plane.

    success_count = 0

    for fname in image_files:
        img = cv2.imread(fname)
        if img is None:
            print(f"Warning: Could not read {fname}")
            continue
            
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # Find the chess board corners
        ret, corners = cv2.findChessboardCorners(gray, board_size, None)

        if ret == True:
            objpoints.append(objp)
            corners2 = cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)
            imgpoints.append(corners2)
            success_count += 1
            print(f"Detected corners in: {os.path.basename(fname)}")
        else:
            print(f"Failed to detect corners in: {os.path.basename(fname)}")

    if success_count < 1:
        raise ValueError("No chessboard corners were detected in any of the provided images.")

    print(f"Calibrating with {success_count} valid images...")
    
    # Calibrate
    ret, mtx, dist, rvecs, tvecs = cv2.calibrateCamera(objpoints, imgpoints, gray.shape[::-1], None, None)

    return mtx, dist

import json

def save_calibration_data(mtx, dist, output_dir="data/interim/calibration"):
    os.makedirs(output_dir, exist_ok=True)
    
    # Save as numpy files
    np.save(os.path.join(output_dir, "intrinsic_matrix.npy"), mtx)
    np.save(os.path.join(output_dir, "distortion_coeffs.npy"), dist)
    
    # Save as JSON (easier for Python/web use)
    start_data = {
        "intrinsic_matrix": mtx.tolist(),
        "distortion_coefficients": dist.tolist()
    }
    
    with open(os.path.join(output_dir, "calibration.json"), "w") as f:
        json.dump(start_data, f, indent=4)
    
    with open(os.path.join(output_dir, "calibration_result.txt"), "w") as f:
        f.write("Intrinsic Matrix (K):\n")
        f.write(str(mtx))
        f.write("\n\nDistortion Coefficients:\n")
    print(f"Calibration data saved to {output_dir}")
