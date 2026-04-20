"""
MQTT Subscription Manager
--------------------------
Maintains a single paho-mqtt client per (broker, port) pair.
Subscriptions are tracked by node_id so the flow executor can
register / deregister topics without tearing down the connection.

Messages are stored in a bounded deque per node_id so the SSE
endpoint can serve them to the frontend.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("app.mqtt.manager")

try:
    import paho.mqtt.client as mqtt_client

    MQTT_AVAILABLE = True
except ImportError:
    MQTT_AVAILABLE = False
    logger.warning("[MQTTManager] paho-mqtt not installed — MQTT nodes will be inactive")


# Maximum messages kept per node_id subscription
_MAX_MESSAGES = 200


class _MQTTConnection:
    """A single paho client bound to one broker:port."""

    def __init__(self, broker: str, port: int):
        self.broker = broker
        self.port = port
        self._client: Optional[Any] = None
        self._connected = False
        self._lock = threading.Lock()
        # node_id → { topic, qos, messages_deque }
        self._subscriptions: Dict[str, Dict] = {}
        # Callbacks registered by SSE streams: node_id → list[Callable]
        self._listeners: Dict[str, List[Callable]] = {}
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._connect()

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def _connect(self):
        if not MQTT_AVAILABLE:
            return

        # paho-mqtt 2.x requires explicit CallbackAPIVersion; fall back gracefully
        try:
            self._client = mqtt_client.Client(
                mqtt_client.CallbackAPIVersion.VERSION1,
                client_id=f"oc4dt_{int(time.time())}",
                clean_session=True,
            )
        except AttributeError:
            # paho < 2.0 doesn't have CallbackAPIVersion
            self._client = mqtt_client.Client(
                client_id=f"oc4dt_{int(time.time())}",
                clean_session=True,
            )
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self._client.on_message = self._on_message

        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        while self._running:
            try:
                logger.info("[MQTTManager] Connecting to %s:%s", self.broker, self.port)
                self._client.connect(self.broker, self.port, keepalive=60)
                self._client.loop_forever()
            except Exception as exc:
                logger.error("[MQTTManager] Connection error: %s — retrying in 5 s", exc)
            if self._running:
                time.sleep(5)

    def _on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            self._connected = True
            logger.info("[MQTTManager] Connected to %s:%s", self.broker, self.port)
            # Re-subscribe all registered topics
            with self._lock:
                for sub in self._subscriptions.values():
                    client.subscribe(sub["topic"], sub["qos"])
                    logger.info("[MQTTManager] Re-subscribed to %s", sub["topic"])
        else:
            logger.warning("[MQTTManager] Connect failed rc=%s", rc)

    def _on_disconnect(self, client, userdata, rc):
        self._connected = False
        logger.warning("[MQTTManager] Disconnected rc=%s", rc)

    def _on_message(self, client, userdata, msg):
        try:
            raw = msg.payload.decode("utf-8", errors="replace")
        except Exception:
            raw = repr(msg.payload)

        # Try to parse JSON
        try:
            import json
            payload = json.loads(raw)
        except Exception:
            payload = raw

        entry = {
            "timestamp": datetime.now().isoformat(),
            "topic": msg.topic,
            "payload": payload,
            "raw": raw,
            "qos": msg.qos,
        }

        # Find which subscriptions match this topic
        with self._lock:
            for node_id, sub in self._subscriptions.items():
                if self._topic_matches(sub["topic"], msg.topic):
                    sub["messages"].append(entry)
                    # Notify SSE listeners
                    for cb in list(self._listeners.get(node_id, [])):
                        try:
                            cb(entry)
                        except Exception:
                            pass

    @staticmethod
    def _topic_matches(pattern: str, topic: str) -> bool:
        """Basic MQTT wildcard matching (+ and #)."""
        if pattern == topic:
            return True
        p_parts = pattern.split("/")
        t_parts = topic.split("/")
        return _match_parts(p_parts, t_parts)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def subscribe(self, node_id: str, topic: str, qos: int = 0):
        with self._lock:
            if node_id in self._subscriptions:
                old = self._subscriptions[node_id]
                if old["topic"] == topic and old["qos"] == qos:
                    return  # already subscribed
                # Unsubscribe old topic
                if self._connected:
                    self._client.unsubscribe(old["topic"])

            self._subscriptions[node_id] = {
                "topic": topic,
                "qos": qos,
                "messages": deque(maxlen=_MAX_MESSAGES),
            }

        if self._connected and self._client:
            self._client.subscribe(topic, qos)
            logger.info("[MQTTManager] Subscribed node=%s topic=%s qos=%s", node_id, topic, qos)

    def unsubscribe(self, node_id: str):
        with self._lock:
            sub = self._subscriptions.pop(node_id, None)
        if sub and self._connected and self._client:
            # Only unsubscribe if no other node uses the same topic
            still_used = any(s["topic"] == sub["topic"] for s in self._subscriptions.values())
            if not still_used:
                self._client.unsubscribe(sub["topic"])

    def get_messages(self, node_id: str) -> List[Dict]:
        with self._lock:
            sub = self._subscriptions.get(node_id)
            if not sub:
                return []
            return list(sub["messages"])

    def pop_messages(self, node_id: str) -> List[Dict]:
        """Return and clear all buffered messages for this node."""
        with self._lock:
            sub = self._subscriptions.get(node_id)
            if not sub:
                return []
            msgs = list(sub["messages"])
            sub["messages"].clear()
            return msgs

    def add_listener(self, node_id: str, cb: Callable):
        with self._lock:
            self._listeners.setdefault(node_id, []).append(cb)

    def remove_listener(self, node_id: str, cb: Callable):
        with self._lock:
            lst = self._listeners.get(node_id, [])
            try:
                lst.remove(cb)
            except ValueError:
                pass

    def is_connected(self) -> bool:
        return self._connected

    def stop(self):
        self._running = False
        if self._client:
            try:
                self._client.disconnect()
                self._client.loop_stop()
            except Exception:
                pass


def _match_parts(p: List[str], t: List[str]) -> bool:
    if not p:
        return not t
    if p[0] == "#":
        return True
    if not t:
        return False
    if p[0] == "+" or p[0] == t[0]:
        return _match_parts(p[1:], t[1:])
    return False


# ---------------------------------------------------------------------------
# Global registry: (broker, port) → _MQTTConnection
# ---------------------------------------------------------------------------

_connections: Dict[str, _MQTTConnection] = {}
_registry_lock = threading.Lock()


def _key(broker: str, port: int) -> str:
    return f"{broker}:{port}"


def get_connection(broker: str, port: int) -> _MQTTConnection:
    k = _key(broker, port)
    with _registry_lock:
        if k not in _connections:
            _connections[k] = _MQTTConnection(broker, port)
        return _connections[k]


def subscribe_node(node_id: str, broker: str, port: int, topic: str, qos: int = 0) -> _MQTTConnection:
    conn = get_connection(broker, port)
    conn.subscribe(node_id, topic, qos)
    return conn


def unsubscribe_node(node_id: str, broker: str, port: int):
    k = _key(broker, port)
    with _registry_lock:
        conn = _connections.get(k)
    if conn:
        conn.unsubscribe(node_id)


def get_messages(node_id: str, broker: str, port: int) -> List[Dict]:
    k = _key(broker, port)
    with _registry_lock:
        conn = _connections.get(k)
    if not conn:
        return []
    return conn.get_messages(node_id)


def add_listener(node_id: str, broker: str, port: int, cb: Callable):
    conn = get_connection(broker, port)
    conn.add_listener(node_id, cb)


def remove_listener(node_id: str, broker: str, port: int, cb: Callable):
    k = _key(broker, port)
    with _registry_lock:
        conn = _connections.get(k)
    if conn:
        conn.remove_listener(node_id, cb)
