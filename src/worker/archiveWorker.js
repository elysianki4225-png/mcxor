/**
 * Dedicated Web Worker for Non-Blocking Large Archive Analysis, XOR Crypto & Streaming Packaging
 * Maintains at most ONE active session and explicitly frees all references on reset/replacement.
 */

import { analyzeArchiveInput, processArchiveSession } from '../core/archiveEngine.js';

let currentSession = null;
let activeTaskId = null;
const cancelledTaskIds = new Set();

function clearCurrentSession() {
  if (currentSession) {
    currentSession.zipBlob = null;
    currentSession.virtualEntries = [];
    currentSession.inferredKeyBytes = null;
    currentSession = null;
  }
}

self.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'CANCEL_TASK') {
    if (msg.taskId) cancelledTaskIds.add(msg.taskId);
    if (activeTaskId) cancelledTaskIds.add(activeTaskId);
    return;
  }

  if (msg.type === 'RELEASE_MEMORY') {
    if (activeTaskId) cancelledTaskIds.add(activeTaskId);
    clearCurrentSession();
    cancelledTaskIds.clear();
    self.postMessage({ type: 'MEMORY_RELEASED', requestId: msg.requestId });
    return;
  }

  if (msg.type === 'ANALYZE_ARCHIVE') {
    const { taskId, payload } = msg;
    activeTaskId = taskId;
    // Always release previous archive session before loading a new one -> zero memory accumulation!
    clearCurrentSession();

    try {
      const { session, analysis } = await analyzeArchiveInput(payload, {
        shouldCancel: () => cancelledTaskIds.has(taskId),
        onProgress: (progress) => {
          self.postMessage({ type: 'TASK_PROGRESS', taskId, progress });
        },
      });

      if (cancelledTaskIds.has(taskId)) {
        cancelledTaskIds.delete(taskId);
        self.postMessage({ type: 'TASK_CANCELLED', taskId });
        return;
      }

      currentSession = session;
      const transferList = [];
      if (analysis.worldIconBytes && analysis.worldIconBytes.buffer) {
        transferList.push(analysis.worldIconBytes.buffer);
      }
      self.postMessage({ type: 'ANALYZE_DONE', taskId, analysis }, transferList);
    } catch (err) {
      clearCurrentSession();
      if (err && err.message === 'OPERATION_CANCELLED') {
        cancelledTaskIds.delete(taskId);
        self.postMessage({ type: 'TASK_CANCELLED', taskId });
      } else {
        self.postMessage({
          type: 'TASK_ERROR',
          taskId,
          error: (err && err.message) || '解析存档时发生未知错误',
        });
      }
    } finally {
      if (activeTaskId === taskId) activeTaskId = null;
      cancelledTaskIds.delete(taskId);
    }
    return;
  }

  if (msg.type === 'PROCESS_ARCHIVE') {
    const { taskId, params } = msg;
    activeTaskId = taskId;

    try {
      const result = await processArchiveSession(currentSession, params, {
        shouldCancel: () => cancelledTaskIds.has(taskId),
        onProgress: (progress) => {
          self.postMessage({ type: 'TASK_PROGRESS', taskId, progress });
        },
      });

      if (cancelledTaskIds.has(taskId)) {
        cancelledTaskIds.delete(taskId);
        self.postMessage({ type: 'TASK_CANCELLED', taskId });
        return;
      }

      self.postMessage({ type: 'PROCESS_DONE', taskId, result });
    } catch (err) {
      if (err && err.message === 'OPERATION_CANCELLED') {
        cancelledTaskIds.delete(taskId);
        self.postMessage({ type: 'TASK_CANCELLED', taskId });
      } else {
        self.postMessage({
          type: 'TASK_ERROR',
          taskId,
          error: (err && err.message) || '执行加解密时发生未知错误',
        });
      }
    } finally {
      if (activeTaskId === taskId) activeTaskId = null;
      cancelledTaskIds.delete(taskId);
    }
  }
});
