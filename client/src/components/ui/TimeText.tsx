import { formatUtcDateTime, parseDate, type DateInput } from '../../utils/formatters';

interface TimeTextProps {
  /** A Date, an ISO string or epoch milliseconds. */
  value: DateInput;
  /** Shown when the value is missing or not a valid time. */
  fallback?: string;
}

/** A UTC date and time, with the visitor's local time on hover. */
export default function TimeText({ value, fallback = '—' }: TimeTextProps) {
  const date = parseDate(value);
  if (!date) return <>{fallback}</>;
  return (
    <time dateTime={date.toISOString()} title={`Your local time: ${date.toLocaleString()}`}>
      {formatUtcDateTime(date)}
    </time>
  );
}
