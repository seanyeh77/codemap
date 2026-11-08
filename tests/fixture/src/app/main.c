/*
 * app - starts the program under test with the fixture library loaded.
 */
#include <stdlib.h>
#include <unistd.h>
#include "api.h"

int main(int argc, char **argv)
{
    struct ops o;
    install(&o);
    setenv("FIXTURE_QUEUE", "q0", 1);
    if (argc > 1)
        execvp(argv[1], argv + 1);
    return use(&o, 1);
}
