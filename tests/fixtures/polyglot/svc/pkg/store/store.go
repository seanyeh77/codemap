package store

type Store struct{ items []string }

func New() *Store {
	return &Store{}
}

func (s *Store) Put(k string) {
	s.items = append(s.items, normalize(k))
}

func normalize(k string) string {
	return k
}
