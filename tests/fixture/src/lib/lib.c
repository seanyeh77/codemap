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

int last_send(void)
{
    return saved_send_value;
}

int peek_a(void)
{
    return last_send();
}

int peek_b(void)
{
    return last_send() + 1;
}

/* a flag read by name: see fixture_debug() below */
static int flag(const char *name)
{
    return getenv(name) != 0;
}

int fixture_debug(void)
{
    return flag("FIXTURE_DEBUG");
}

static int cmp(const void *a, const void *b)
{
    (void)a; (void)b;
    return 0;
}

void sort_it(int *v, int n)
{
    qsort(v, n, sizeof *v, cmp);
}
