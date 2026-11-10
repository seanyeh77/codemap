package store

import "errors"

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

// ValidationError says what is wrong with a key.
type ValidationError struct{ Key string }

func (e *ValidationError) Error() string { return "bad key " + e.Key }

// Validate returns only *ValidationError, or nil.
func Validate(key string) error {
	if key == "" {
		return &ValidationError{Key: key}
	}
	return nil
}

// Check returns an error made outside the repository.
func Check(key string) error {
	return errors.New("check " + key)
}
