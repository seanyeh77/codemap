package server

import (
	"time"

	"example.com/gofix/store"
)

// Clocked keeps its clock in a field so that tests can replace it.
type Clocked struct {
	Now  func() time.Time
	Done func()
	St   store.Store
}

// NewClocked uses the real clock and the in-memory store; done is the caller's, or noop.
func NewClocked(done func()) *Clocked {
	c := &Clocked{Now: time.Now, Done: done, St: store.New()}
	if done == nil {
		c.Done = noop
	}
	return c
}

func noop() {}

func (c *Clocked) Stamp() int64 {
	c.St.Get("t")
	c.Done()
	return c.Now().Unix()
}

func (c *Clocked) Errors() {
	err := store.Validate("")
	_ = err.Error()
	other := store.Check("k")
	_ = other.Error()
}
