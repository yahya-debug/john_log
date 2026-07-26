import amqplib, { ConfirmChannel } from 'amqplib';

export function publish<T>(ch: ConfirmChannel, exchange: string, routingKey: string, value: T) {
    const serialized_val = Buffer.from(JSON.stringify(value), 'utf-8');
    ch.publish(exchange, routingKey, serialized_val, { 'contentType': 'application/json' });
}

