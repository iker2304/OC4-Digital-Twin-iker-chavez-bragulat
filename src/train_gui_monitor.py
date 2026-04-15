import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext
import subprocess
import threading
import queue
import time
import os
import re
import glob
from datetime import datetime, timedelta
import logging

try:
    from matplotlib.figure import Figure
    from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
    import pandas as pd
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False

class TrainMonitorGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("YOLO Training Monitor")
        self.root.geometry("1100x700")
        self.root.resizable(True, True)

        self.process = None
        self.is_running = False
        self.start_time = None
        self.output_queue = queue.Queue()
        
        self.current_epoch = 0
        self.total_epochs = 100
        
        self.history = {
            'epoch': [],
            'box_loss': [],
            'pose_loss': [],
            'map50': [],
            'map50_95': []
        }
        
        self.results_csv_path = None
        self.last_csv_mtime = 0

        self._setup_ui()
        self._update_loop()

    def _setup_ui(self):
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # Header
        header_frame = ttk.Frame(main_frame)
        header_frame.pack(fill=tk.X, pady=(0, 10))
        
        self.status_label = ttk.Label(header_frame, text="Status: Ready to start", font=("Arial", 12, "bold"))
        self.status_label.pack(side=tk.LEFT)

        self.start_button = ttk.Button(header_frame, text="Start Training", command=self.start_process)
        self.start_button.pack(side=tk.RIGHT, padx=5)
        
        self.cancel_button = ttk.Button(header_frame, text="Cancel", command=self.cancel_process, state=tk.DISABLED)
        self.cancel_button.pack(side=tk.RIGHT, padx=5)

        # Progress
        self.progress_var = tk.DoubleVar()
        self.progress_bar = ttk.Progressbar(main_frame, variable=self.progress_var, maximum=100)
        self.progress_bar.pack(fill=tk.X, pady=5)

        # Content Frame (Stats + Graphs)
        content_frame = ttk.Frame(main_frame)
        content_frame.pack(fill=tk.BOTH, expand=True, pady=10)
        
        # Left: Stats
        stats_frame = ttk.LabelFrame(content_frame, text=" Real-time Statistics ", padding="10")
        stats_frame.pack(side=tk.LEFT, fill=tk.Y, padx=(0, 10))

        self.epoch_label = self._create_stat_label(stats_frame, "Epoch:", "0 / 0", 0, 0)
        self.elapsed_label = self._create_stat_label(stats_frame, "Elapsed Time:", "00:00:00", 1, 0)
        self.eta_label = self._create_stat_label(stats_frame, "ETA:", "Calculating...", 2, 0)
        
        ttk.Separator(stats_frame, orient=tk.HORIZONTAL).grid(row=3, column=0, columnspan=2, sticky="ew", pady=10)
        
        self.box_loss_label = self._create_stat_label(stats_frame, "Box Loss:", "0.000", 4, 0)
        self.pose_loss_label = self._create_stat_label(stats_frame, "Pose Loss:", "0.000", 5, 0)
        self.map50_label = self._create_stat_label(stats_frame, "mAP50:", "0.000", 6, 0)

        # Right: Graphs
        graph_frame = ttk.LabelFrame(content_frame, text=" Training Metrics ", padding="5")
        graph_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        if HAS_MATPLOTLIB:
            self.fig = Figure(figsize=(6, 4), dpi=100)
            self.ax1 = self.fig.add_subplot(211)
            self.ax2 = self.fig.add_subplot(212)
            
            self.fig.tight_layout(pad=3.0)
            
            self.canvas = FigureCanvasTkAgg(self.fig, master=graph_frame)
            self.canvas.get_tk_widget().pack(fill=tk.BOTH, expand=True)
            self._init_plots()
        else:
            ttk.Label(graph_frame, text="Matplotlib or Pandas not installed. Graphs disabled.").pack(padx=20, pady=20)

        # Bottom: Console
        log_frame = ttk.LabelFrame(main_frame, text=" Console Output ", padding="5")
        log_frame.pack(fill=tk.BOTH, expand=True)
        
        self.log_area = scrolledtext.ScrolledText(log_frame, height=10, font=("Consolas", 9))
        self.log_area.pack(fill=tk.BOTH, expand=True)

    def _create_stat_label(self, parent, text, initial_val, row, col):
        frame = ttk.Frame(parent)
        frame.grid(row=row, column=col, sticky="w", padx=5, pady=5)
        ttk.Label(frame, text=text, font=("Arial", 10)).pack(side=tk.LEFT)
        val_label = ttk.Label(frame, text=initial_val, font=("Arial", 10, "bold"))
        val_label.pack(side=tk.LEFT, padx=(5, 0))
        return val_label

    def _init_plots(self):
        self.ax1.clear()
        self.ax2.clear()
        self.ax1.set_title("Losses")
        self.ax1.set_ylabel("Loss")
        self.ax2.set_title("Metrics")
        self.ax2.set_ylabel("mAP")
        self.ax2.set_xlabel("Epoch")
        self.canvas.draw()

    def _update_plots(self):
        if not HAS_MATPLOTLIB or len(self.history['epoch']) == 0:
            return
            
        self.ax1.clear()
        self.ax2.clear()
        
        epochs = self.history['epoch']
        
        # Losses
        if len(self.history['box_loss']) > 0:
            self.ax1.plot(epochs, self.history['box_loss'], label='Box Loss', color='blue')
        if len(self.history['pose_loss']) > 0:
            self.ax1.plot(epochs, self.history['pose_loss'], label='Pose Loss', color='red')
            
        self.ax1.set_title("Training Losses")
        self.ax1.set_ylabel("Loss")
        self.ax1.legend(loc="upper right")
        self.ax1.grid(True, linestyle='--', alpha=0.7)

        # Metrics
        if len(self.history['map50']) > 0:
            self.ax2.plot(epochs, self.history['map50'], label='mAP50', color='green')
        if len(self.history['map50_95']) > 0:
            self.ax2.plot(epochs, self.history['map50_95'], label='mAP50-95', color='purple')
            
        self.ax2.set_title("Validation Metrics")
        self.ax2.set_ylabel("mAP")
        self.ax2.set_xlabel("Epoch")
        self.ax2.legend(loc="lower right")
        self.ax2.grid(True, linestyle='--', alpha=0.7)
        
        self.fig.tight_layout(pad=3.0)
        self.canvas.draw()

    def start_process(self):
        if self.is_running:
            return

        script_path = os.path.join("utils", "scripts", "train", "train_yolo_pose.py")
        if not os.path.exists(script_path):
            messagebox.showerror("Error", f"Training script not found at {script_path}")
            return
            
        self.is_running = True
        self.start_time = time.time()
        self.current_epoch = 0
        self.history = {k: [] for k in self.history}
        self.results_csv_path = None
        self.last_csv_mtime = 0
        
        # Reset UI explicitly so no old data shows
        self.box_loss_label.config(text="0.000")
        self.pose_loss_label.config(text="0.000")
        self.map50_label.config(text="0.000")
        self.epoch_label.config(text=f"0 / {self.total_epochs}")
        self.progress_var.set(0)
        self.eta_label.config(text="Calculating...")
        
        if HAS_MATPLOTLIB:
            self._init_plots()
            
        self.log_area.delete(1.0, tk.END)
        self.status_label.config(text="Status: Training in progress...", foreground="blue")
        self.start_button.config(state=tk.DISABLED)
        self.cancel_button.config(state=tk.NORMAL)

        def run():
            try:
                env = os.environ.copy()
                env["PYTHONUNBUFFERED"] = "1"
                
                self.process = subprocess.Popen(
                    ["python", script_path],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    encoding='utf-8',
                    errors='replace',
                    env=env,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
                )

                # Read output character by character to handle \r updates in YOLO progress bars
                buffer = ""
                while True:
                    char = self.process.stdout.read(1)
                    if not char:
                        break
                        
                    if char == '\r' or char == '\n':
                        if buffer.strip():
                            self.output_queue.put(buffer)
                        buffer = ""
                    else:
                        buffer += char
                        
                self.process.wait()
                self.is_running = False
                self.output_queue.put("DONE")
            except Exception as e:
                self.output_queue.put(f"ERROR: {str(e)}")
                self.is_running = False

        threading.Thread(target=run, daemon=True).start()

    def cancel_process(self):
        if self.process and self.process.poll() is None:
            if messagebox.askyesno("Confirm", "Are you sure you want to stop the training?"):
                self.process.terminate()
                self.status_label.config(text="Status: Cancelled", foreground="red")
                self.is_running = False
                self.start_button.config(state=tk.NORMAL)
                self.cancel_button.config(state=tk.DISABLED)

    def _update_loop(self):
        try:
            # Process queue (up to 50 lines to avoid freezing UI)
            count = 0
            while not self.output_queue.empty() and count < 50:
                line = self.output_queue.get_nowait()
                count += 1
                
                if line == "DONE":
                    self.status_label.config(text="Status: Finished successfully", foreground="green")
                    self.start_button.config(state=tk.NORMAL)
                    self.cancel_button.config(state=tk.DISABLED)
                    messagebox.showinfo("Completed", "Training has finished.")
                    continue
                
                if line.startswith("ERROR:"):
                    self.status_label.config(text=f"Status: {line}", foreground="red")
                    self.start_button.config(state=tk.NORMAL)
                    self.cancel_button.config(state=tk.DISABLED)
                    continue

                # Add to log area
                self.log_area.insert(tk.END, line + "\n")
                self.log_area.see(tk.END)
                
                # Parse current epoch from console output
                epoch_match = re.search(r"Epoch\s+(\d+)/(\d+)", line)
                if epoch_match:
                    self.current_epoch = int(epoch_match.group(1))
                    self.total_epochs = int(epoch_match.group(2))
                    self._update_stats_ui()

            if self.is_running:
                self._update_time_only()
                self._check_results_csv()

        finally:
            self.root.after(100, self._update_loop)

    def _check_results_csv(self):
        # Look for the YOLO results file
        if not self.results_csv_path and self.start_time:
            possible_paths = glob.glob(os.path.join("data", "models", "CV", "pose", "train*", "results.csv"))
            # ONLY grab the CSV if it was created/modified AFTER we clicked "Start Training"
            valid_paths = [p for p in possible_paths if os.path.getmtime(p) >= self.start_time]
            if valid_paths:
                # Get the most recently modified directory's results.csv
                self.results_csv_path = max(valid_paths, key=os.path.getmtime)
                
        if self.results_csv_path and os.path.exists(self.results_csv_path):
            current_mtime = os.path.getmtime(self.results_csv_path)
            if current_mtime > self.last_csv_mtime:
                self.last_csv_mtime = current_mtime
                self._parse_csv()

    def _parse_csv(self):
        if not HAS_MATPLOTLIB:
            return
            
        try:
            df = pd.read_csv(self.results_csv_path)
            df.columns = df.columns.str.strip()
            
            if 'epoch' in df.columns and len(df) > 0:
                self.history['epoch'] = df['epoch'].tolist()
                
                # Find matching columns dynamically
                box_col = next((c for c in df.columns if 'train/box_loss' in c), None)
                pose_col = next((c for c in df.columns if 'train/pose_loss' in c), None)
                map50_col = next((c for c in df.columns if 'metrics/mAP50(P)' in c or 'metrics/mAP50(B)' in c), None)
                map50_95_col = next((c for c in df.columns if 'metrics/mAP50-95(P)' in c or 'metrics/mAP50-95(B)' in c), None)
                
                if box_col: self.history['box_loss'] = df[box_col].tolist()
                if pose_col: self.history['pose_loss'] = df[pose_col].tolist()
                if map50_col: self.history['map50'] = df[map50_col].tolist()
                if map50_95_col: self.history['map50_95'] = df[map50_95_col].tolist()
                
                if len(self.history['epoch']) > 0:
                    csv_epoch = int(self.history['epoch'][-1])
                    if csv_epoch >= self.current_epoch:
                        self.current_epoch = csv_epoch
                        
                    if box_col: self.box_loss_label.config(text=f"{self.history['box_loss'][-1]:.4f}")
                    if pose_col: self.pose_loss_label.config(text=f"{self.history['pose_loss'][-1]:.4f}")
                    if map50_col: self.map50_label.config(text=f"{self.history['map50'][-1]:.4f}")
                    
                self._update_plots()
                self._update_stats_ui()
                
        except Exception as e:
            logging.error(f"Error parsing CSV: {e}")

    def _update_stats_ui(self):
        if self.total_epochs > 0:
            progress_pct = (self.current_epoch / self.total_epochs) * 100
            self.progress_var.set(progress_pct)
        
        self.epoch_label.config(text=f"{self.current_epoch} / {self.total_epochs}")
        
        if self.current_epoch > 0 and self.start_time:
            elapsed = time.time() - self.start_time
            time_per_epoch = elapsed / self.current_epoch
            remaining_epochs = self.total_epochs - self.current_epoch
            eta_seconds = remaining_epochs * time_per_epoch
            self.eta_label.config(text=str(timedelta(seconds=int(eta_seconds))))

    def _update_time_only(self):
        if self.start_time:
            elapsed = int(time.time() - self.start_time)
            self.elapsed_label.config(text=str(timedelta(seconds=elapsed)))

if __name__ == "__main__":
    root = tk.Tk()
    app = TrainMonitorGUI(root)
    root.mainloop()
