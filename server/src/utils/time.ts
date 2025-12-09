import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

export const withTz = (input?: string | number | Date, tz = 'UTC') => dayjs(input).tz(tz);

export const startOfDay = (date: Date, tz: string) => withTz(date, tz).startOf('day');

export const endOfDay = (date: Date, tz: string) => withTz(date, tz).endOf('day');

export const isSameDay = (a: Date, b: Date, tz: string) => startOfDay(a, tz).isSame(startOfDay(b, tz));

export const formatDisplayDate = (date: Date, tz: string) => withTz(date, tz).format('YYYY-MM-DD HH:mm');
