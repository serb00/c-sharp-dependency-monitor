import { EventEmitter, NotificationEvent } from './types';

export class ExtensionEventEmitter<T = any> implements EventEmitter<T> {
    private listeners: Map<string, Array<(data: T) => void>> = new Map();

    on(event: string, listener: (data: T) => void): void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event)!.push(listener);
    }

    off(event: string, listener: (data: T) => void): void {
        const eventListeners = this.listeners.get(event);
        if (eventListeners) {
            const index = eventListeners.indexOf(listener);
            if (index !== -1) {
                eventListeners.splice(index, 1);
            }
        }
    }

    emit(event: string, data: T): void {
        const eventListeners = this.listeners.get(event);
        if (eventListeners) {
            eventListeners.forEach(listener => {
                try {
                    listener(data);
                } catch (error) {
                    console.error(`Error in event listener for ${event}:`, error);
                }
            });
        }
    }

    clear(): void {
        this.listeners.clear();
    }

    getEventNames(): string[] {
        return Array.from(this.listeners.keys());
    }

    getListenerCount(event: string): number {
        return this.listeners.get(event)?.length || 0;
    }
}

// Global event bus for the extension
export const eventBus = new ExtensionEventEmitter<NotificationEvent>();

// Event constants
export const Events = {
    ANALYSIS_STARTED: 'analysis.started',
    ANALYSIS_COMPLETED: 'analysis.completed',
    ANALYSIS_ERROR: 'analysis.error',
    CIRCULAR_DEPENDENCY_FOUND: 'circular.dependency.found',
    CIRCULAR_DEPENDENCY_RESOLVED: 'circular.dependency.resolved',
    FILE_CHANGED: 'file.changed',
    CONFIG_CHANGED: 'config.changed',
    CACHE_CLEARED: 'cache.cleared',
    VISUALIZATION_REQUESTED: 'visualization.requested'
} as const;

export type EventType = typeof Events[keyof typeof Events];