import { useState } from 'react';
import { useTwinStore } from '../../store/twinStore';
import type { TwinConfigUpdate } from '../../types';

export const DetectionSettings = () => {
    const updateConfig = useTwinStore((state) => state.updateConfig);

    // Local state to manage detection settings
    const [conf, setConf] = useState(0.25);
    const [iou, setIou] = useState(0.45);
    const [showBoxes, setShowBoxes] = useState(true);
    const [showKpts, setShowKpts] = useState(true);
    const [recording, setRecording] = useState(false);
    const [recordingSpeed, setRecordingSpeed] = useState(1);

    // Function called when we change any setting
    const handleUpdate = (newSettings: TwinConfigUpdate) => {
        updateConfig(newSettings);
    };

    return (
        <div className="bg-white p-4 rounded-lg shadow-lg border border-gray-200 text-gray-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white">
            <h3 className="text-lg font-bold mb-4">Detection Settings</h3>
            
            {/* Confidence Threshold (Slider) */}
            <div className="mb-4">
                <label className="block text-sm mb-1">Confidence Threshold: {conf}</label>
                <input 
                type="range" min="0.01" max="1" step="0.01" 
                value={conf}
                onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    setConf(val);
                    handleUpdate({ conf: val });
                }}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-slate-600"
                />
            </div>

            {/* IOU Threshold (Slider) */}
            <div className="mb-4">
                <label className="block text-sm mb-1">IoU Threshold: {iou}</label>
                <input 
                type="range" min="0.01" max="1" step="0.01" 
                value={iou}
                onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    setIou(val);
                    handleUpdate({ iou: val });
                }}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-slate-600"
                />
            </div>

            <div className="mb-4">
                <label className="block text-sm mb-1">Recording Speed: {recordingSpeed}x</label>
                <input
                type="range" min="0.25" max="4" step="0.25"
                value={recordingSpeed}
                onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    setRecordingSpeed(val);
                    handleUpdate({ recording_speed: val });
                }}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-slate-600"
                />
            </div>

            {/* Visualization Buttons */}
            <div className="flex gap-2 mt-4">
                <button 
                onClick={() => {
                    const val = !showBoxes;
                    setShowBoxes(val);
                    handleUpdate({ show_boxes: val });
                }}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    showBoxes
                        ? 'bg-blue-600 hover:bg-blue-500 text-white'
                        : 'bg-gray-200 hover:bg-gray-300 text-gray-900 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-white'
                }`}
                >
                {showBoxes ? 'Hide BBoxes' : 'Show BBoxes'}
                </button>

                <button 
                onClick={() => {
                    const val = !showKpts;
                    setShowKpts(val);
                    handleUpdate({ show_kpts: val });
                }}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    showKpts
                        ? 'bg-purple-600 hover:bg-purple-500 text-white'
                        : 'bg-gray-200 hover:bg-gray-300 text-gray-900 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-white'
                }`}
                >
                {showKpts ? 'Hide Keypoints' : 'Show Keypoints'}
                </button>

                <button
                onClick={() => {
                    const val = !recording;
                    setRecording(val);
                    handleUpdate({ recording: val });
                }}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    recording
                        ? 'bg-red-600 hover:bg-red-500 text-white'
                        : 'bg-gray-200 hover:bg-gray-300 text-gray-900 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-white'
                }`}
                >
                {recording ? 'Stop Recording' : 'Start Recording'}
                </button>
            </div>
            </div>
        );       


};
