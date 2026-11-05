#ifndef API_H
#define API_H
#ifndef QUEUE_SLOTS
#define QUEUE_SLOTS 16u
#endif
#define LOG_CALL(x) log_event(x)
struct ops { int (*send)(int); };
void log_event(int v);
void install(struct ops *o);
int use(struct ops *o, int v);
#endif
