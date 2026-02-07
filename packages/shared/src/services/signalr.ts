import * as signalR from '@microsoft/signalr';
import { getApiBase } from './api.js';
import { getStorage } from '../storage.js';

let connection: signalR.HubConnection | null = null;

export function getConnection(): signalR.HubConnection {
  if (connection) return connection;

  connection = new signalR.HubConnectionBuilder()
    .withUrl(`${getApiBase()}/hubs/chat`, {
      accessTokenFactory: () => getStorage().getItem('token') || '',
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
