import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext
import subprocess
import threading
import queue
import time
import os
import re
import json
from datetime import datetime, timedelta
import logging

class DatasetMonitorGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("Dataset Generation Monitor")
        self.root.geometry("800x600")
        self.root.resizable(True, True)

        # Variables de estado
        self.process = None
        self.is_running = False
        self.start_time = None
        self.total_images = 0
        self.current_image = 0
        self.image_times = []
        self.output_queue = queue.Queue()
        self.log_file = "data/synthetic_dataset/pose/generation_log.json"
        
        # Asegurar directorio de log
        os.makedirs(os.path.dirname(self.log_file), exist_ok=True)
        
        # Configurar logging
        logging.basicConfig(
            filename="data/synthetic_dataset/pose/execution.log",
            level=logging.INFO,
            format='%(asctime)s - %(levelname)s - %(message)s'
        )

        self._setup_ui()
        self._update_loop()

    def _setup_ui(self):
        # Frame Principal
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # Título y Estado
        header_frame = ttk.Frame(main_frame)
        header_frame.pack(fill=tk.X, pady=(0, 10))
        
        self.status_label = ttk.Label(header_frame, text="Estado: Listo para iniciar", font=("Arial", 12, "bold"))
        self.status_label.pack(side=tk.LEFT)

        # Botones
        self.start_button = ttk.Button(header_frame, text="Iniciar Generación", command=self.start_process)
        self.start_button.pack(side=tk.RIGHT, padx=5)
        
        self.cancel_button = ttk.Button(header_frame, text="Cancelar", command=self.cancel_process, state=tk.DISABLED)
        self.cancel_button.pack(side=tk.RIGHT, padx=5)

        # Barra de Progreso
        self.progress_var = tk.DoubleVar()
        self.progress_bar = ttk.Progressbar(main_frame, variable=self.progress_var, maximum=100)
        self.progress_bar.pack(fill=tk.X, pady=10)

        # Estadísticas en Grid
        stats_frame = ttk.LabelFrame(main_frame, text=" Estadísticas en Tiempo Real ", padding="10")
        stats_frame.pack(fill=tk.X, pady=10)

        # Labels de estadísticas
        self.img_counter_label = self._create_stat_label(stats_frame, "Última imagen:", "0 / 0", 0, 0)
        self.percent_label = self._create_stat_label(stats_frame, "Progreso:", "0.00%", 0, 1)
        self.elapsed_label = self._create_stat_label(stats_frame, "Tiempo transcurrido:", "00:00:00", 1, 0)
        self.eta_label = self._create_stat_label(stats_frame, "Tiempo restante (ETA):", "Calculando...", 1, 1)
        self.avg_time_label = self._create_stat_label(stats_frame, "Tiempo medio / img:", "0.00s", 2, 0)
        self.img_min_label = self._create_stat_label(stats_frame, "Imágenes / min:", "0.00", 2, 1)

        # Área de Log
        log_frame = ttk.LabelFrame(main_frame, text=" Salida del Proceso (Consola) ", padding="5")
        log_frame.pack(fill=tk.BOTH, expand=True, pady=(10, 0))
        
        self.log_area = scrolledtext.ScrolledText(log_frame, height=15, font=("Consolas", 9))
        self.log_area.pack(fill=tk.BOTH, expand=True)

    def _create_stat_label(self, parent, text, initial_val, row, col):
        frame = ttk.Frame(parent)
        frame.grid(row=row, column=col, sticky="w", padx=20, pady=5)
        ttk.Label(frame, text=text, font=("Arial", 10)).pack(side=tk.LEFT)
        val_label = ttk.Label(frame, text=initial_val, font=("Arial", 10, "bold"))
        val_label.pack(side=tk.LEFT, padx=(5, 0))
        return val_label

    def start_process(self):
        if self.is_running:
            return

        # Comando de Blender
        blender_path = r"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe"
        if not os.path.exists(blender_path):
            # Intentar encontrar otras versiones si la 4.5 no existe
            potential_paths = [
                r"C:\Program Files\Blender Foundation\Blender 4.0\blender.exe",
                r"C:\Program Files\Blender Foundation\Blender 4.1\blender.exe",
                r"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe",
            ]
            for p in potential_paths:
                if os.path.exists(p):
                    blender_path = p
                    break
        
        args = ["-b", "-P", r".\src\generate_dataset_pose.py"]
        
        # Resetear estado
        self.is_running = True
        self.start_time = time.time()
        self.current_image = 0
        self.image_times = []
        self.log_area.delete(1.0, tk.END)
        self.status_label.config(text="Estado: Ejecutando Blender...", foreground="blue")
        self.start_button.config(state=tk.DISABLED)
        self.cancel_button.config(state=tk.NORMAL)
        
        logging.info("Iniciando proceso de generación de dataset...")

        def run():
            try:
                self.process = subprocess.Popen(
                    [blender_path] + args,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    universal_newlines=True,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
                )

                for line in self.process.stdout:
                    self.output_queue.put(line)
                
                self.process.wait()
                self.is_running = False
                self.output_queue.put("DONE")
            except Exception as e:
                self.output_queue.put(f"ERROR: {str(e)}")
                self.is_running = False

        threading.Thread(target=run, daemon=True).start()

    def cancel_process(self):
        if self.process and self.process.poll() is None:
            if messagebox.askyesno("Confirmar", "¿Estás seguro de que quieres detener la generación?"):
                self.process.terminate()
                logging.warning("Proceso cancelado por el usuario.")
                self.status_label.config(text="Estado: Cancelado", foreground="red")
                self.is_running = False

    def _update_loop(self):
        try:
            while not self.output_queue.empty():
                line = self.output_queue.get_nowait()
                
                if line == "DONE":
                    self.status_label.config(text="Estado: Finalizado con éxito", foreground="green")
                    self.start_button.config(state=tk.NORMAL)
                    self.cancel_button.config(state=tk.DISABLED)
                    self._save_final_stats()
                    messagebox.showinfo("Completado", "La generación del dataset ha finalizado.")
                    continue
                
                if line.startswith("ERROR:"):
                    self.status_label.config(text=f"Estado: {line}", foreground="red")
                    self.start_button.config(state=tk.NORMAL)
                    self.cancel_button.config(state=tk.DISABLED)
                    logging.error(line)
                    continue

                self.log_area.insert(tk.END, line)
                self.log_area.see(tk.END)
                
                # Parsear progreso
                # Formato esperado: [POSE] Rendering X/Y
                match = re.search(r"\[POSE\] Rendering (\d+)/(\d+)", line)
                if match:
                    current = int(match.group(1))
                    total = int(match.group(2))
                    self.total_images = total
                    
                    if current > self.current_image:
                        now = time.time()
                        if self.current_image > 0:
                            # Calcular tiempo de la última imagen
                            last_img_time = now - (self.last_img_timestamp if hasattr(self, 'last_img_timestamp') else self.start_time)
                            self.image_times.append(last_img_time)
                        
                        self.current_image = current
                        self.last_img_timestamp = now
                        self._update_stats()

            if self.is_running:
                self._update_time_only()

        finally:
            self.root.after(100, self._update_loop)

    def _update_stats(self):
        # Actualizar labels e interfaz
        progress_pct = (self.current_image / self.total_images) * 100
        self.progress_var.set(progress_pct)
        
        self.img_counter_label.config(text=f"{self.current_image} / {self.total_images}")
        self.percent_label.config(text=f"{progress_pct:.2f}%")
        
        # Calcular promedios
        if self.image_times:
            avg_time = sum(self.image_times) / len(self.image_times)
            self.avg_time_label.config(text=f"{avg_time:.2f}s")
            
            # Imágenes por minuto
            img_per_min = 60 / avg_time if avg_time > 0 else 0
            self.img_min_label.config(text=f"{img_per_min:.2f}")
            
            # ETA
            remaining = self.total_images - self.current_image
            eta_seconds = remaining * avg_time
            eta_str = str(timedelta(seconds=int(eta_seconds)))
            self.eta_label.config(text=eta_str)

    def _update_time_only(self):
        if self.start_time:
            elapsed = int(time.time() - self.start_time)
            self.elapsed_label.config(text=str(timedelta(seconds=elapsed)))

    def _save_final_stats(self):
        elapsed = time.time() - self.start_time
        avg_time = sum(self.image_times) / len(self.image_times) if self.image_times else 0
        
        stats = {
            "fecha": datetime.now().isoformat(),
            "imagenes_totales": self.total_images,
            "imagenes_procesadas": self.current_image,
            "tiempo_total_segundos": elapsed,
            "tiempo_medio_por_imagen": avg_time,
            "estado_final": "Completado" if self.current_image == self.total_images else "Incompleto"
        }
        
        with open(self.log_file, 'w') as f:
            json.dump(stats, f, indent=4)
        
        logging.info(f"Estadísticas finales guardadas en {self.log_file}")

if __name__ == "__main__":
    root = tk.Tk()
    app = DatasetMonitorGUI(root)
    root.mainloop()
