import FreeSimpleGUI as sg
import cv2
import numpy as np
import sys
import os
from pathlib import Path

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from camera_calibration import calibrate_camera, save_calibration_data, generate_chessboard_image

sg.theme('DarkBlue3')

def main():
    layout = [
        [sg.Text("Camera Calbration", font=('Helvetica', 16))],
        [sg.Text("Image directory:"), sg.Input(key='-FOLDER-', size=50), sg.FolderBrowse()],
        [sg.Text("Board size (inner corners):"), sg.Input('9', key='-W-', size=5), sg.Text('x'), sg.Input('6', key='-H-', size=5)],
        [sg.Text("Real square size (mm):"), sg.Input('25.0', key='-SQSIZE-')],
        [sg.Button('Generate Reference Chessboard'), sg.Button('Calibrate'), sg.Button('Exit')],
        [sg.Output(size=(80,15), key='-OUTPUT-')],
        [sg.Text("Intrinsic matrix will be saved to the selected folder")]
    ]

    window = sg.Window('Camera Calibration', layout, finalize=True)

    while True:
        event, values = window.read()
        if event in (sg.WIN_CLOSED, 'Exit'):
            break

        if event == 'Generate Reference Chessboard':
            generate_chessboard_image((9,6), 100, "data/interim/calibration/chessboard_ref.png")
            sg.popup("Chessboard generated in data/interim/calibration/chessboard_ref.png")

        if event == 'Calibrate':
            try:
                folder = values['-FOLDER-']
                if not folder:
                    sg.popup_error("Select a folder with images")
                    continue

                w, h = int(values['-W-']), int(values['-H-'])
                sq_size = float(values['-SQSIZE-'])

                images = list(Path(folder).glob("*.jpg")) + list(Path(folder).glob("*.png")) + list(Path(folder).glob("*.jpeg"))
                if len(images) < 5:
                    sg.popup_error(f"Only {len(images)} images found. Recommended ≥10-20")
                    continue

                print(f"Processing {len(images)} images...")
                mtx, dist = calibrate_camera([str(p) for p in images], (w, h), sq_size)
                
                save_calibration_data(mtx, dist, folder)
                print("\nCalibration completed!")
                print("Intrinsic matrix K:\n", mtx)
                print("Distortion:\n", dist)

            except Exception as e:
                sg.popup_error(f"Error during calibration:\n{str(e)}")

    window.close()

if __name__ == '__main__':
    main()