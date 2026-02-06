import * as signalR from '@microsoft/signalr';
import { API_BASE } from './api';

let connection: signalR.HubConnection | null = null;

export function getConnection(): signalR.HubConnection {
  if (connection) return connection;

  const token = localStorage.getItem('token');
  connection = new signalR.HubConnectionBuilder()
    .withUrl(`${API_BASE}/hubs/chat`, {
      accessTokenFactory: () => token || '',
    })
    .withAutomaticReconnect()
    .build();

  return connection;
}

let startPromise: Promise<signalR.HubConnection> | null = null;

export function startConnection(): Promise<signalR.HubConnection> {
  const conn = getConnection();
  if (conn.state === signalR.HubConnectionState.Connected) {
    return Promise.resolve(conn);
  }
  if (!startPromise) {
    startPromise = conn.start().then(() => {
      startPromise = null;
      return conn;
    }).catch((err) => {
      startPromise = null;
      throw err;
    });
  }
  return startPromise;
}

export function ensureConnected(): Promise<signalR.HubConnection> {
  return startConnection();
}

export async function stopConnection(): Promise<void> {
  startPromise = null;
  if (connection) {
    await connection.stop();
    connection = null;
  }
}

export function resetConnection(): void {
  startPromise = null;
  connection = null;
}
