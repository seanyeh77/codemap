#include <stdlib.h>
#include "api.h"

static int saved_send_value;

void log_event(int v)
{
    saved_send_value = v;
}

static int traced_send(int v)
{
    LOG_CALL(v);
    return v + 1;
}

void install(struct ops *o)
{
    o->send = traced_send;
}

int use(struct ops *o, int v)
{
    return o->send(v);
}

__attribute__((constructor))
static void attach(void)
{
    const char *q = getenv("FIXTURE_QUEUE");
    (void)q;
}

#ifdef LEGACY
int pick(void) { return 1; }
#else
int pick(void) { return 2; }
#endif
