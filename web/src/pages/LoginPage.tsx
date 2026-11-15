import { useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { User, Mail, Lock, Eye, EyeOff, ArrowRight, Radio, Cpu, GitBranch, Activity } from 'lucide-react';
import cimneLogo from '../assets/cimne-logo.png';
import { Button } from '../components/ui';

export default function LoginPage() {
  const [isRegistering, setIsRegistering] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const { login, register, error, clearError } = useAuthStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (isRegistering) {
        await register(username, email, password, displayName);
      } else {
        await login(username, password);
      }
    } finally {
      setLoading(false);
    }
  };

  const toggleMode = () => {
    setIsRegistering(!isRegistering);
    clearError();
    setUsername('');
    setEmail('');
    setPassword('');
    setDisplayName('');
  };

  const features = [
    { icon: Radio, title: 'Telemetría MQTT', desc: 'Flujo de datos cinemáticos en tiempo real' },
    { icon: Cpu, title: 'Visión por computador', desc: 'Estimación de pose con modelos YOLO' },
    { icon: GitBranch, title: 'Flujos de datos', desc: 'Editor visual de nodos y procesamiento' },
    { icon: Activity, title: 'Análisis SHM y FEM', desc: 'Fatiga acumulada y respuesta modal' },
  ];

  return (
    <div className="flex min-h-screen bg-zinc-50 text-zinc-900 dark:bg-[#0c0c0e] dark:text-zinc-100">
      {/* Left panel — overview */}
      <div className="hidden w-1/2 flex-col justify-between border-r border-zinc-200 bg-white p-12 lg:flex dark:border-zinc-800/80 dark:bg-zinc-950">
        <div className="flex items-center gap-3">
          <img src={cimneLogo} alt="CIMNE" className="h-5 w-auto object-contain dark:brightness-0 dark:invert" />
          <span className="border-l border-zinc-200 pl-3 text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            Digital Twin Platform
          </span>
        </div>

        <div className="max-w-md space-y-8">
          <div className="space-y-3">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Monitorización y simulación de gemelos digitales
            </h1>
            <p className="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
              Entorno unificado para seguimiento óptico 6-DOF, integridad estructural (SHM/FEM) y entrenamiento de modelos de visión artificial.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {features.map((f, i) => (
              <div
                key={i}
                className="rounded-lg border border-zinc-200 p-3.5 dark:border-zinc-800"
              >
                <f.icon className="mb-2 h-4 w-4 text-zinc-500 dark:text-zinc-400" strokeWidth={1.75} />
                <p className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">{f.title}</p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          CIMNE · Universitat Politècnica de Catalunya
        </p>
      </div>

      {/* Right panel — form */}
      <div className="flex w-full items-center justify-center p-6 lg:w-1/2">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <img src={cimneLogo} alt="CIMNE" className="h-4 w-auto object-contain dark:brightness-0 dark:invert" />
            <span className="border-l border-zinc-200 pl-3 text-xs font-medium text-zinc-500 dark:border-zinc-800">
              Digital Twin Platform
            </span>
          </div>

          <div className="ui-card p-6 sm:p-7">
            <div className="mb-6">
              <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                {isRegistering ? 'Crear cuenta' : 'Iniciar sesión'}
              </h2>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                {isRegistering
                  ? 'Registra un usuario para gestionar gemelos y flujos'
                  : 'Accede a tus configuraciones de gemelo digital'}
              </p>
            </div>

            {error && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-400">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="login-username" className="ui-label">Usuario</label>
                <div className="relative">
                  <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                  <input
                    id="login-username"
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    className="ui-input pl-9"
                    placeholder="Nombre de usuario"
                    required
                  />
                </div>
              </div>

              {isRegistering && (
                <>
                  <div>
                    <label htmlFor="register-displayname" className="ui-label">Nombre visible</label>
                    <div className="relative">
                      <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                      <input
                        id="register-displayname"
                        type="text"
                        value={displayName}
                        onChange={e => setDisplayName(e.target.value)}
                        className="ui-input pl-9"
                        placeholder="Tu nombre"
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="register-email" className="ui-label">Correo electrónico</label>
                    <div className="relative">
                      <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                      <input
                        id="register-email"
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        className="ui-input pl-9"
                        placeholder="nombre@dominio.com"
                        required
                      />
                    </div>
                  </div>
                </>
              )}

              <div>
                <label htmlFor="login-password" className="ui-label">Contraseña</label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="ui-input pl-9 pr-9"
                    placeholder="••••••••"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <Button
                id="login-submit"
                type="submit"
                variant="primary"
                disabled={loading}
                className="w-full justify-center"
              >
                {loading ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <>
                    {isRegistering ? 'Crear cuenta' : 'Entrar'}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>

              <Button
                type="button"
                variant="secondary"
                disabled={loading}
                onClick={async () => {
                  setLoading(true);
                  try {
                    const ok = await login('admin', 'admin123');
                    if (!ok) {
                      await register('admin', 'admin@digitaltwin.local', 'admin123', 'Ingeniero Digital Twin');
                    }
                  } finally {
                    setLoading(false);
                  }
                }}
                className="w-full justify-center"
              >
                Acceso rápido de demostración
              </Button>
            </form>

            <p className="mt-5 text-center text-xs text-zinc-500 dark:text-zinc-400">
              {isRegistering ? '¿Ya tienes una cuenta?' : '¿No tienes cuenta?'}
              <button
                id="toggle-auth-mode"
                type="button"
                onClick={toggleMode}
                className="ml-1.5 font-medium text-zinc-900 underline-offset-4 hover:underline dark:text-zinc-100"
              >
                {isRegistering ? 'Iniciar sesión' : 'Registrarse'}
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
