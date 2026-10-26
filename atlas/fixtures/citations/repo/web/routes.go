package web

import (
	"encoding/json"
	"net/http"

	"example.com/shop/orders"
)

// Routes maps each URL of the shop to its handler.
func Routes(o *orders.Service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /books", listBooks)
	mux.HandleFunc("POST /checkout", checkout(o))
	return mux
}

type cart struct {
	Email string        `json:"email"`
	Lines []orders.Line `json:"lines"`
}

func checkout(o *orders.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var c cart
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			http.Error(w, "a cart is JSON", http.StatusBadRequest)
			return
		}

		id, err := o.Place(r.Context(), c.Email, c.Lines)
		if err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}

		json.NewEncoder(w).Encode(map[string]int64{"order": id})
	}
}

func listBooks(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`[]`))
}
