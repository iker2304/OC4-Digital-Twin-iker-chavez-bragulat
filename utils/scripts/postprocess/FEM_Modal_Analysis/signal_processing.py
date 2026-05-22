import time
import threading
import numpy as np
import sys
import os
import hydra
from collections import deque
from omegaconf import DictConfig
from scipy import signal as scipy_signal
from datetime import datetime

# Damping estimation via Half-Power Bandwidth
import importlib, sys as _sys
_damping_mod_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "backend", "app", "api"))
if _damping_mod_path not in _sys.path:
    _sys.path.insert(0, _damping_mod_path)
from damping import calcular_amortiguamiento

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", ".."))
if project_root not in sys.path:
    sys.path.append(project_root)

from utils.scripts.comm.mqtt import MqttClient

# ============================================================================
# CONFIGURATION
# ============================================================================

# MQTT Connection
MQTT_BROKER = "localhost"
MQTT_PORT   = 1883
MQTT_TOPIC  = "oc4/pose"

# Circular buffer — power of 2 for efficient FFT
BUFFER_SIZE = 512

# Default sample rate — overridden at runtime by the FPS reported in each MQTT message
SAMPLE_RATE_HZ = 10.0

# FFT Computation
FFT_SIZE                = 500          # Number of samples per FFT window
MIN_SAMPLES_FFT         = 256          # Minimum samples before first FFT (25.6 s)
FFT_COMPUTE_EVERY       = 10           # Run FFT every N new samples (1 s)
FFT_PRINT_EVERY         = 50           # Print results every N new samples (5 s)

# Derived frequency parameters — recomputed dynamically when SAMPLE_RATE_HZ changes
FREQ_RESOLUTION_HZ      = SAMPLE_RATE_HZ / FFT_SIZE  # 0.02 Hz per bin
FREQ_MAX_HZ             = SAMPLE_RATE_HZ / 2          # Nyquist limit = 5 Hz
DOMINANT_FREQ_HISTORY   = 100          # Number of dominant frequencies kept in history

# Windowing — reduces spectral leakage
WINDOW_TYPE             = 'hann'
USE_ZERO_PADDING        = True         # Pad to BUFFER_SIZE for faster FFT

# Peak detection thresholds
PEAK_THRESHOLD_DB       = -40          # Ignore peaks more than 40 dB below the maximum
PEAK_MIN_DISTANCE_HZ    = 0.05         # Minimum separation between peaks (> Δf)

# Optional low-pass Butterworth filter
USE_FILTERING           = True
FILTER_CUTOFF_HZ        = 5.0          # Cutoff frequency in Hz
FILTER_ORDER            = 2

# Expected structural modal frequencies of the OC4 semi-submersible (keypoint index → Hz)
MODAL_FREQUENCIES = {
    13: 0.51,    # Primary surge
    14: 0.57,    # Primary sway
    15: 2.05,    # Secondary surge
    20: 4.38,    # Primary heave
}

# ============================================================================
# VIBRATION ANALYZER CLASS
# ============================================================================

class VibrationAnalyzer:
    """Analyses structural vibration via FFT, detects spectral peaks, and
    matches them against known OC4 modal frequencies."""

    def __init__(self):
        self.dominant_freq_history  = deque(maxlen=DOMINANT_FREQ_HISTORY)
        self.detected_modes_history = deque(maxlen=50)
        self.last_fft_time          = 0

        # Sample rate — updated at runtime from the camera FPS in MQTT messages
        self.sample_rate_hz   = SAMPLE_RATE_HZ
        self.freq_resolution  = SAMPLE_RATE_HZ / FFT_SIZE
        self.freq_max         = SAMPLE_RATE_HZ / 2

        # Running statistics updated after every FFT
        self.stats = {
            'total_samples': 0,
            'total_ffts': 0,
            'detected_modes': {},
            'avg_dominant_freq': 0.0,
        }

        if USE_FILTERING:
            self.setup_filter()

        print("=" * 70)
        print("VIBRATION ANALYZER INITIALIZED")
        print(f"  FFT Size: {FFT_SIZE} samples")
        print(f"  Sampling Rate: {self.sample_rate_hz} Hz (default — will update from camera FPS)")
        print(f"  Freq Resolution: {self.freq_resolution:.4f} Hz")
        print(f"  Freq Max (Nyquist): {self.freq_max:.2f} Hz")
        print(f"  Time per FFT: {FFT_SIZE/self.sample_rate_hz:.1f} seconds")
        print(f"  Min samples: {MIN_SAMPLES_FFT} ({MIN_SAMPLES_FFT/self.sample_rate_hz:.1f}s)")
        print(f"  Window: {WINDOW_TYPE}")
        print("=" * 70)

    def update_sample_rate(self, new_fps: float) -> None:
        """Update the sample rate from the camera FPS reported in the MQTT message."""
        if new_fps <= 0:
            return
        if abs(new_fps - self.sample_rate_hz) < 0.1:
            return  # No meaningful change
        self.sample_rate_hz  = new_fps
        self.freq_resolution = new_fps / FFT_SIZE
        self.freq_max        = new_fps / 2
        print(f"[SAMPLE RATE] Updated to {new_fps:.2f} Hz (camera FPS) — "
              f"Nyquist={self.freq_max:.2f} Hz, Δf={self.freq_resolution:.4f} Hz")
        if USE_FILTERING:
            self.setup_filter()

    def setup_filter(self):
        """Design a low-pass Butterworth filter and compute its initial delay state."""
        nyquist = self.sample_rate_hz / 2
        effective_cutoff = min(FILTER_CUTOFF_HZ, nyquist * 0.99)
        normalized_cutoff = effective_cutoff / nyquist

        self.filter_b, self.filter_a = scipy_signal.butter(
            FILTER_ORDER,
            normalized_cutoff,
            btype='low'
        )
        self.filter_state = scipy_signal.lfilter_zi(self.filter_b, self.filter_a)
        print(f"  Butterworth filter: cutoff={effective_cutoff:.3f}Hz (requested {FILTER_CUTOFF_HZ}Hz), order={FILTER_ORDER}")
    
    def apply_filter(self, signal_data):
        """Apply the Butterworth filter while preserving state for streaming (avoids phase discontinuities)."""
        if not USE_FILTERING:
            return signal_data
        
        filtered, self.filter_state = scipy_signal.lfilter(
            self.filter_b,
            self.filter_a,
            signal_data,
            zi=self.filter_state * signal_data[0]
        )
        return filtered
    
    def perform_fft(self, samples: list) -> dict:
        """Compute the FFT of the sample window and return a result dict.

        Steps: filter → window → (optional) zero-pad → rfft → peak detection → mode matching.
        """
        signal_data = np.array(samples, dtype=float)

        # 1. Optional low-pass filter
        signal_data = self.apply_filter(signal_data)

        # 2. Spectral window to reduce leakage
        if WINDOW_TYPE == 'hann':
            window = np.hanning(len(signal_data))
        elif WINDOW_TYPE == 'hamming':
            window = np.hamming(len(signal_data))
        else:
            window = np.ones(len(signal_data))
        
        signal_windowed = signal_data * window

        # 3. FFT with optional zero-padding to BUFFER_SIZE
        if USE_ZERO_PADDING:
            n_fft = BUFFER_SIZE
        else:
            n_fft = len(signal_windowed)
        
        fft_result = np.fft.rfft(signal_windowed, n=n_fft)
        freqs = np.fft.rfftfreq(n_fft, d=1.0 / self.sample_rate_hz)
        
        # 4. Magnitude and power spectrum
        magnitude = np.abs(fft_result)
        power     = magnitude ** 2
        power_db  = 10 * np.log10(np.maximum(power, 1e-10))  # guard against log(0)

        # Dominant frequency bin
        dom_idx = np.argmax(power)
        dom_freq = freqs[dom_idx]
        dom_amp = magnitude[dom_idx]
        dom_power = power[dom_idx]
        
        # 5a. Peak detection — convert dB threshold to linear scale
        threshold_linear = np.max(power) * (10 ** (PEAK_THRESHOLD_DB / 10))

        peaks, properties = scipy_signal.find_peaks(
            power,
            height=threshold_linear,
            distance=int(PEAK_MIN_DISTANCE_HZ / FREQ_RESOLUTION_HZ)
        )
        
        # Keep only the top-10 peaks by power
        if len(peaks) > 0:
            sorted_peaks = peaks[np.argsort(power[peaks])[::-1]][:10]
            peak_freqs = freqs[sorted_peaks]
            peak_powers = power[sorted_peaks]
            peak_mags = magnitude[sorted_peaks]
        else:
            peak_freqs = []
            peak_powers = []
            peak_mags = []
            sorted_peaks = np.array([], dtype=int)
        
        # 5b. Damping ratio via Half-Power Bandwidth for each peak
        damping_ratios = []
        if len(sorted_peaks) > 0:
            try:
                damping_ratios = calcular_amortiguamiento(freqs, magnitude, sorted_peaks)
            except Exception:
                pass

        # 5c. Match peaks against known modal frequencies
        matched_modes = self._match_modes(peak_freqs, peak_mags)

        # Update history and statistics
        self.dominant_freq_history.append(dom_freq)
        if matched_modes:
            self.detected_modes_history.append(matched_modes)

        self.stats['total_ffts'] += 1
        self.stats['avg_dominant_freq'] = np.mean(self.dominant_freq_history)

        for mode_id, _ in matched_modes:
            self.stats['detected_modes'][mode_id] = \
                self.stats['detected_modes'].get(mode_id, 0) + 1
        
        # Compile and return results
        result = {
            'timestamp': datetime.now().isoformat(),
            'n_samples': len(signal_data),
            'dominant_freq': dom_freq,
            'dominant_amplitude': dom_amp,
            'dominant_power': dom_power,
            'dominant_power_db': power_db[dom_idx],
            'frequencies': freqs,
            'magnitude': magnitude,
            'power': power,
            'power_db': power_db,
            'peak_frequencies': peak_freqs,
            'peak_magnitudes': peak_mags,
            'peak_powers': peak_powers,
            'n_peaks': len(peak_freqs),
            'matched_modes': matched_modes,
            'damping_ratios': damping_ratios,
            'freq_resolution': self.freq_resolution,
            'sample_rate_hz': self.sample_rate_hz,
        }
        
        return result
    
    def _match_modes(self, peak_freqs, peak_mags) -> list:
        """Match detected spectral peaks against known OC4 modal frequencies.

        A peak is a match if it falls within ±2·Δf of a modal frequency.
        Returns a list of (mode_id, amplitude) tuples.
        """
        matched_modes = []

        for mode_id, modal_freq in MODAL_FREQUENCIES.items():
            nearby_idx = np.where(
                np.abs(peak_freqs - modal_freq) <= self.freq_resolution * 2
            )[0]
            
            if len(nearby_idx) > 0:
                idx = nearby_idx[0]
                matched_modes.append((mode_id, peak_mags[idx]))
        
        return matched_modes
    
    def print_fft_result(self, result: dict, sample_count: int) -> None:

        print(f"\n{'='*70}")
        print(f"[{result['timestamp']}] FFT ANALYSIS #{self.stats['total_ffts']}")
        print(f"{'='*70}")

        print(f"Samples: {result['n_samples']:4d} | Time: {result['n_samples']/self.sample_rate_hz:6.1f}s | "
              f"Total count: {sample_count:6d} ({sample_count/self.sample_rate_hz:6.1f}s)")

        print(f"\nDOMINANT FREQUENCY:")
        print(f"   Frequency: {result['dominant_freq']:.4f} Hz")
        print(f"   Amplitude: {result['dominant_amplitude']:.6f}")
        print(f"   Power: {result['dominant_power']:.6f} | {result['dominant_power_db']:.2f} dB")

        if result['n_peaks'] > 0:
            print(f"\nPEAKS DETECTED ({result['n_peaks']}):")
            print(f"  {'Freq (Hz)':<12} {'Amplitude':<12} {'Power':<12}")
            print(f"  {'-'*35}")
            for freq, mag, power in zip(
                result['peak_frequencies'][:5],
                result['peak_magnitudes'][:5],
                result['peak_powers'][:5]
            ):
                print(f"  {freq:<12.4f} {mag:<12.6f} {power:<12.6f}")
            if result['n_peaks'] > 5:
                print(f"  ... and {result['n_peaks'] - 5} more peaks")

        if result['matched_modes']:
            print(f"\n✓ MODES IDENTIFIED:")
            for mode_id, amplitude in result['matched_modes']:
                modal_freq = MODAL_FREQUENCIES[mode_id]
                count = self.stats['detected_modes'].get(mode_id, 0)
                print(f"   Mode {mode_id}: f={modal_freq:.2f}Hz, A={amplitude:.6f} "
                      f"(detected {count} times)")
        else:
            print(f"\n✗ NO MODES IDENTIFIED")

        # Damping ratios
        if result.get('damping_ratios'):
            print(f"\nDAMPING RATIOS (Half-Power Bandwidth):")
            print(f"  {'fn (Hz)':<12} {'ζ':<12} {'BW (Hz)':<12} {'f1 (Hz)':<12} {'f2 (Hz)':<12}")
            print(f"  {'-'*58}")
            for dr in result['damping_ratios']:
                zeta_str = f"{dr['zeta']:.6f}" if dr['zeta'] is not None else "N/A"
                bw_str   = f"{dr['bw_hz']:.6f}" if dr['bw_hz'] is not None else "N/A"
                f1_str   = f"{dr['f1_hz']:.4f}" if dr['f1_hz'] is not None else "N/A"
                f2_str   = f"{dr['f2_hz']:.4f}" if dr['f2_hz'] is not None else "N/A"
                print(f"  {dr['fn_hz']:<12.4f} {zeta_str:<12} {bw_str:<12} {f1_str:<12} {f2_str:<12}")
        
        
        # Estadísticas
        print(f"\nSTATISTICS:")
        print(f"   Total FFTs: {self.stats['total_ffts']}")
        print(f"   Avg dominant freq: {self.stats['avg_dominant_freq']:.4f} Hz")
        print(f"   Freq resolution: {result['freq_resolution']:.4f} Hz")
        print(f"   Nyquist freq: {self.freq_max:.2f} Hz")
        print(f"{'='*70}\n")

@hydra.main(version_base=None, config_path="config", config_name="FEM_modal.yaml")
def main(config: DictConfig):
    """Subscribe to MQTT pose data and run real-time vibration / modal analysis."""

    print("\n" + "="*70)
    print("FEM MODAL ANALYSIS WITH MQTT")
    print("="*70)
    print("Config:")
    print(config)
    print("="*70 + "\n")

    analyzer     = VibrationAnalyzer()
    data_buffer  = deque(maxlen=BUFFER_SIZE)
    sample_count = 0
    _lock        = threading.Lock()

    def on_mqtt_message(data: dict) -> None:
        """Called by MqttClient for each message on MQTT_TOPIC.

        Extracts the scalar to analyse, appends it to the ring buffer, and
        triggers an FFT computation according to FFT_COMPUTE_EVERY.
        """
        nonlocal sample_count

        # Update sample rate from the real-time camera FPS included in every MQTT message
        fps = data.get("fps")
        if fps and fps > 0:
            analyzer.update_sample_rate(float(fps))

        # Extract a scalar from the MQTT payload.
        # pose_detection.py publishes:
        #   { "points": { "pilar_center": {"x":..,"y":..,"confidence":..}, ... }, ... }
        value = None
        keypoint_key = getattr(config, "keypoint_analysis", None)

        # 1. Try direct top-level key
        if keypoint_key:
            raw = data.get(keypoint_key)
            if isinstance(raw, (int, float)):
                value = float(raw)

        # 2. Try nested in "points" dict (standard pose_detection.py output)
        if value is None:
            pts = data.get("points", {})
            kp_key = keypoint_key or "Hub" #"pilar_center"
            kp = pts.get(kp_key) if isinstance(pts, dict) else None
            if isinstance(kp, dict):
                v = kp.get("y", kp.get("x"))
                if v is not None:
                    value = float(v)
            elif isinstance(kp, (int, float)):
                value = float(kp)

        # 3. Fallback: first element of "pose" array
        if value is None:
            pose = data.get("pose")
            if pose is not None and len(pose) > 0:
                value = float(pose[0])

        if value is None:
            return

        with _lock:
            data_buffer.append(float(value))
            sample_count += 1
            count = sample_count

            should_compute_fft = (count % FFT_COMPUTE_EVERY == 0)
            should_print       = (count % FFT_PRINT_EVERY   == 0)

            buf_snapshot = list(data_buffer) if should_compute_fft else None

        # FFT runs outside the lock so it does not block incoming MQTT messages
        if buf_snapshot is not None and len(buf_snapshot) >= MIN_SAMPLES_FFT:
            result = analyzer.perform_fft(buf_snapshot)
            if should_print:
                analyzer.print_fft_result(result, count)

    mqtt_client = MqttClient(
        MQTT_BROKER,
        MQTT_PORT,
        MQTT_TOPIC,
        on_message_callback=on_mqtt_message
    )
    
    print(f"Connecting to MQTT: {MQTT_BROKER}:{MQTT_PORT}")
    print(f"Topic: '{MQTT_TOPIC}'")
    print(f"Press Ctrl+C to stop\n")
    
    try:
        # Keep the main thread alive; print a brief buffer status every second
        while True:
            time.sleep(1)

            with _lock:
                n_buffer = len(data_buffer)
                n_total  = sample_count

            time_elapsed = n_total / analyzer.sample_rate_hz
            print(f"[{time_elapsed:6.1f}s] Buffer: {n_buffer:3d}/{BUFFER_SIZE} | "
                  f"Total: {n_total:4d} | FFTs: {analyzer.stats['total_ffts']:3d} | "
                  f"SR: {analyzer.sample_rate_hz:.1f} Hz")
    
    except KeyboardInterrupt:
        print("\nShutting down...")
    
    finally:
        mqtt_client.disconnect()
        print("Disconnected.")

        # Session summary
        print("\n" + "="*70)
        print("FINAL STATISTICS")
        print("="*70)
        print(f"Total samples received: {sample_count}")
        print(f"Total FFTs computed: {analyzer.stats['total_ffts']}")
        print(f"Average dominant frequency: {analyzer.stats['avg_dominant_freq']:.4f} Hz")
        print(f"Modes detected:")
        for mode_id in sorted(MODAL_FREQUENCIES.keys()):
            count = analyzer.stats['detected_modes'].get(mode_id, 0)
            freq = MODAL_FREQUENCIES[mode_id]
            print(f"  Mode {mode_id} (f={freq:.2f}Hz): {count} times")
        print("="*70 + "\n")


if __name__ == "__main__":
    main()