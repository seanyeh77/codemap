package store

// Store keeps values by key.
type Store interface {
	Get(key string) string
}

type mem struct{ data map[string]string }

func (m *mem) Get(key string) string { return m.data[key] }

type disk struct{ dir string }

func (d disk) Get(key string) string { return d.dir + key }

// Counter has a Get too, with another signature: it does not implement Store.
type Counter struct{ n int }

func (c *Counter) Get(i int) int { return c.n + i }

// New returns the in-memory store.
func New() Store {
	return &mem{data: map[string]string{}}
}

// Pick returns either store: its callers cannot know which.
func Pick(onDisk bool) Store {
	if onDisk {
		return disk{dir: "/tmp/"}
	}
	return New()
}
